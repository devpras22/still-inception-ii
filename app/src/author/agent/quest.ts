import type { ImageProvider, LLMProvider, LLMMessage, VisionProvider, VerifiedObject } from '../../provider'
import { selectVerifiedObjects } from '../../provider'
import type { Diagnostic, SMObjective, SMWorld, WorldStore } from '../../world'
import { compileMission, runDoctrine } from '../../world'
import { extractJson, ReplyParseError } from './reply'
import { paintFirstFrame, probeLabels, proposeCandidates } from './generate'
import type { ToolRunner } from './generate'

/**
 * A QUEST from a frame.
 *
 * Where the plain path authors a flat world from a picture, this routes the
 * same probe through the mission stack, so a frame yields ordered objectives,
 * a flag ledger and consequence states — and the grounding is PROBE-VERIFIED
 * rather than guessed.
 *
 * The rule that makes it worth having is the one it inherits from the probe:
 * never build an action on an undetectable object. A language model asked to
 * invent a quest from a picture will happily ground a step on "the ancient
 * mechanism"; the detector then never finds it and the player can never do it.
 * So the model is told which nouns actually detect, and any objective grounded
 * on something else comes back as its own correction round — enforcement, not
 * request, exactly as `generate.ts` enforces anchors.
 *
 * It shares the grounding half of `generate.ts` rather than owning a second
 * copy: paint (or take the frame you were handed), propose candidates, probe
 * them, select. Only the authoring half differs, because a mission is a
 * different thing to ask for than a graph.
 */

const MAX_ROUNDS = 3
const MAX_TOKENS = 12_000

const SYSTEM = `You are the world kernel. You author a MISSION from a single frame of a world.

A mission is 3 to 5 ORDERED objectives. Each one is a thing the player does, in a place,
to an object that is really there. The world is rendered by a video model: your prose is
drawn literally, frame by frame.

Reply with STRICT JSON and nothing else:
{"name":"<the world's title — two or three words>",
 "reply":"<two or three sentences telling the author what you built>",
 "mission":{"id":"<snake_case>","title":"<the quest's name>",
   "win":{"title":"<CARD LINE>","subtitle":"<one line>"},
   "objectives":[
     {"id":"<snake_case>","text":"<the line the player reads — an imperative>",
      "action":"<how the doing LOOKS while it plays: rich, cinematic, one moment>",
      "grounded":{"target":"<one of the VERIFIED nouns>","confirm":"<what is visibly true afterwards>"},
      "outcome":"<the world AFTER it — only when the action changes something>",
      "fail":{"name":"<a tempting wrong move>","action":"<how it looks>","outcome":"<the world, ruined>","title":"<CARD LINE>"}}
   ]}}

THE RULES
- GROUND EVERY OBJECTIVE. "target" must be one of the verified nouns you are given, spelled
  exactly. They are the only things a detector can find in this frame; anything else is an
  action the player can never take.
- The objectives are ORDERED and each one is gated on the one before it. Do not restate that:
  the compiler chains them.
- Give the mission at least one "fail" — a tempting wrong move that ends the run. A quest
  with no way to lose is a list of chores.
- POSITIVE PROSE ONLY. Never write what is absent; the model renders what it reads.
- Do not author states or events. The mission compiles into them.`

export interface QuestResult {
  reply: string
  name: string
  /** The mission id that landed. */
  mission: string
  objectives: number
  diagnostics: Diagnostic[]
  rounds: number
  /** Every noun the probe verified in the frame — what the model was allowed to ground on. */
  verified: string[]
  /** Why `verified` is empty, when it is. */
  probeNote?: string
}

export class QuestError extends Error {
  readonly raw: string
  constructor(message: string, raw = '') {
    super(message)
    this.name = 'QuestError'
    this.raw = raw
  }
}

export async function runQuestGeneration(opts: {
  llm: LLMProvider
  store: WorldStore
  tools?: ToolRunner | undefined
  image?: ImageProvider | undefined
  vision?: VisionProvider | undefined
  worldId: string
  premise: string
  /** An existing frame to build the quest FROM — the "from this picture" path.
   *  Without one, a frame is painted, exactly as `author.generate` does. */
  frame?: { b64: string; mime: string } | undefined
  signal?: AbortSignal | undefined
  progress?: ((note: string) => void) | undefined
}): Promise<QuestResult> {
  const { llm, store, tools, image, vision, worldId, premise, signal } = opts
  const say = opts.progress ?? ((): void => {})

  // STEP 1 — the frame. Handed in, or painted.
  let painted = opts.frame ?? null
  if (!painted) {
    if (image?.isConfigured()) say('Painting the frame the quest happens in…')
    painted = (await paintFirstFrame(image, premise, signal)).frame
  }

  // STEP 2 — probe it. This is the whole reason the pipeline exists: the model
  // may only ground on what the detector actually finds.
  let verified: VerifiedObject[] = []
  let probeNote = ''
  if (painted && vision?.isConfigured()) {
    say('Looking for objects to ground the quest on…')
    const groups = await proposeCandidates(llm, premise, signal)
    if (groups.length === 0) {
      probeNote = 'the model proposed no candidate objects, so the frame was never probed'
    } else {
      say(`Probing the frame for ${groups.map((g) => g.object).join(', ')}…`)
      const probed = await probeLabels(vision, painted.b64, groups, signal)
      verified = selectVerifiedObjects(probed)
      if (verified.length > 0) say(`Verified in the frame: ${verified.map((v) => v.label).join(', ')}`)
      else probeNote = 'nothing proposed was found in the frame — the quest would be ungroundable'
    }
  } else {
    probeNote = painted
      ? 'no vision provider is configured, so nothing in the frame could be verified'
      : 'no frame exists to probe — configure an image provider, or hand a frame in'
  }

  // A quest whose steps cannot be grounded is the failure this path exists to
  // prevent. Say so rather than authoring actions nobody can perform.
  if (verified.length === 0) {
    throw new QuestError(
      `A quest from a frame needs objects the detector can actually find, and ${probeNote}. ` +
        'Every objective would be an action the player could never take.',
    )
  }

  const nouns = verified.map((v) => (v.aliases.length ? `${v.label} (also: ${v.aliases.join(', ')})` : v.label))
  const messages: LLMMessage[] = [
    { role: 'system', content: SYSTEM },
    {
      role: 'user',
      content:
        `Premise: ${premise}\n\nVERIFIED NOUNS — the detector found these in the frame, and these are the ` +
        `ONLY things an objective may be grounded on:\n${nouns.map((n) => `- ${n}`).join('\n')}\n\nAuthor the mission.`,
    },
  ]

  let lastRaw = ''
  for (let round = 1; round <= MAX_ROUNDS; round += 1) {
    say(round === 1 ? 'Authoring the mission…' : `Correcting the mission (round ${round} of ${MAX_ROUNDS})…`)
    const raw = await llm.complete({ json: true, temperature: 0.7, maxTokens: MAX_TOKENS, messages, signal })
    lastRaw = raw

    let parsed: unknown
    try {
      parsed = extractJson(raw)
    } catch (e) {
      if (!(e instanceof ReplyParseError)) throw e
      messages.push({ role: 'assistant', content: raw })
      messages.push({ role: 'user', content: 'That was not valid JSON. Re-emit the whole reply as JSON only.' })
      continue
    }
    if (typeof parsed !== 'object' || parsed === null) continue
    const obj: Record<string, unknown> = { ...parsed }
    const reply = typeof obj['reply'] === 'string' ? obj['reply'] : ''
    const name = typeof obj['name'] === 'string' ? obj['name'].trim() : ''
    const missionRaw = obj['mission']
    if (typeof missionRaw !== 'object' || missionRaw === null) {
      messages.push({ role: 'assistant', content: raw })
      messages.push({ role: 'user', content: 'The reply carried no "mission". Re-emit it.' })
      continue
    }
    const mission: Record<string, unknown> = { ...missionRaw }
    const objectives = Array.isArray(mission['objectives']) ? mission['objectives'] : []

    // ENFORCEMENT, not request: an objective grounded on a noun the probe never
    // verified is an action the player can never perform, so it goes back as a
    // correction round the way a doctrine error does.
    const allowed = new Set<string>()
    for (const v of verified) {
      allowed.add(v.label.toLowerCase())
      for (const a of v.aliases) allowed.add(a.toLowerCase())
    }
    const ungrounded: string[] = []
    for (const o of objectives) {
      if (typeof o !== 'object' || o === null) continue
      const target = (o as { grounded?: { target?: unknown } }).grounded?.target
      if (typeof target === 'string' && target.trim() && !allowed.has(target.trim().toLowerCase())) {
        ungrounded.push(`"${(o as { text?: unknown }).text ?? '?'}" grounds on "${target}"`)
      }
    }
    if (ungrounded.length > 0) {
      messages.push({ role: 'assistant', content: raw })
      messages.push({
        role: 'user' as const,
        content:
          `These objectives ground on nouns the detector did NOT find:\n${ungrounded.map((u) => `- ${u}`).join('\n')}\n\n` +
          `Re-emit the whole mission using ONLY these nouns: ${verified.map((v) => v.label).join(', ')}.`,
      })
      continue
    }

    // Compile it against the world as it stands. A mission that cannot compile
    // is a mission that never reaches the store.
    const world = await readWorld(store, worldId)
    say('Checking the quest against the doctrine…')
    const spec = {
      id: typeof mission['id'] === 'string' && mission['id'].trim() ? mission['id'].trim() : 'mission',
      title: typeof mission['title'] === 'string' && mission['title'].trim() ? mission['title'].trim() : premise.slice(0, 40),
      objectives: objectives.filter(isObjective),
      ...(isWin(mission['win']) ? { win: mission['win'] } : {}),
    }
    if (spec.objectives.length === 0) {
      messages.push({ role: 'assistant', content: raw })
      messages.push({ role: 'user', content: 'No objective carried both an "id" and a "text". Re-emit the mission.' })
      continue
    }

    const preview: SMWorld = { ...world, scene: { states: { ...world.scene.states }, events: [...world.scene.events] } }
    const compiled = compileMission(preview, spec)
    for (const { id, state } of compiled.states) preview.scene.states[id] = state
    for (const { id, ending } of compiled.endings) {
      const target = preview.scene.states[id]
      if (target) target.ending = ending
    }
    preview.scene.events.push(...compiled.events)
    const fresh = runDoctrine(preview)
    const errors = fresh.filter((d) => d.severity === 'error')
    if (errors.length > 0 && round < MAX_ROUNDS) {
      messages.push({ role: 'assistant', content: raw })
      messages.push({
        role: 'user' as const,
        content:
          `The mission compiles into a world the doctrine rejects:\n` +
          errors.slice(0, 6).map((d) => `- [${d.lint}] ${d.path}: ${d.message}`).join('\n') +
          '\n\nRe-emit the whole mission, fixing exactly these.',
      })
      continue
    }
    if (errors.length > 0) {
      throw new QuestError(`The mission still breaks the doctrine after ${round} rounds: ${errors[0]?.message ?? ''}`, raw)
    }

    // Carry the PROBE'S OWN FINDINGS onto the record. Without this the mission
    // that lands is indistinguishable from one a model grounded on invented
    // nouns: the guarantee this whole path exists to make would be checkable
    // only by re-running the probe, never from the artifact. `missionGrounding`
    // reads it back.
    const grounded = { ...spec, verified: verified.map((v) => v.label) }

    // Land it through the same op every other write uses.
    const outcome = tools
      ? await tools.run('author.ops', { world: worldId, ops: [{ op: 'add_mission', ...grounded }] }, { origin: 'agent' })
      : null
    if (outcome && !outcome.ok) throw new QuestError(outcome.error.message, raw)
    if (!tools) {
      const rev = (await store.getScene(worldId)).rev
      await store.applyOps(worldId, [{ op: 'add_mission', ...grounded }], rev)
    }
    if (name) await store.updateWorld(worldId, { name }).catch(() => undefined)

    return {
      reply,
      name,
      mission: spec.id,
      objectives: spec.objectives.length,
      diagnostics: fresh,
      rounds: round,
      verified: verified.map((v) => v.label),
      ...(probeNote ? { probeNote } : {}),
    }
  }
  throw new QuestError(`The model could not author a usable mission in ${MAX_ROUNDS} rounds.`, lastRaw)
}

function isObjective(v: unknown): v is SMObjective {
  return (
    typeof v === 'object' && v !== null &&
    typeof (v as { id?: unknown }).id === 'string' && ((v as { id: string }).id).trim() !== '' &&
    typeof (v as { text?: unknown }).text === 'string' && ((v as { text: string }).text).trim() !== ''
  )
}

function isWin(v: unknown): v is { title: string; subtitle?: string } {
  return typeof v === 'object' && v !== null && typeof (v as { title?: unknown }).title === 'string'
}

async function readWorld(store: WorldStore, worldId: string): Promise<SMWorld> {
  const [doc, scene] = await Promise.all([store.getWorld(worldId), store.getScene(worldId)])
  const base = doc.world ?? doc
  return { ...base, id: worldId, scene: { states: scene.states, events: scene.events } }
}
