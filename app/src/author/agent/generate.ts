/**
 * The kernel agent — a premise becomes a world.
 *
 * This is the piece that made "create from a premise" mean something. Before it,
 * an offline premise produced ONE state holding the premise text and nothing
 * else: no beats, no branches, no ending — a world you could open and not play.
 * This kernel builds a full, playable graph instead, running on whichever
 * language model the author configured.
 *
 * It is the SIBLING of `edit.ts`, not a variant of it, and the difference is the
 * whole design. The editor makes the SMALLEST change that satisfies an
 * instruction. The kernel makes a WHOLE graph: five to eight states, real
 * branches, at least one way to win and one to lose, every state reachable.
 * Sharing one prompt between those two jobs would mean one of them is worded
 * against its own goal.
 *
 * This doctrine is what separates prose a world model can render from prose it
 * cannot:
 *
 *   SUBJECT LOCK   one subject sentence and one atmosphere tail, reused
 *                  byte-identically in every state — the anti-drift rule the
 *                  hand-built worlds live by.
 *   DENSITY        a framing opener, depth from foreground to background, a
 *                  closing atmosphere line. One-line stubs render flat.
 *   EVENT KIND     a transition LANDS the player in a new state and re-seeds the
 *                  scene; an override is a sustained overlay that leaves the
 *                  state intact. Default to override.
 *   CONSEQUENCE    what an action does must resolve: displacement returns to the
 *                  ground, transformation persists afterward, a flicker reverts.
 *   POSITIVE PROSE the model renders what it reads, so the doctrine forbids
 *                  negation in content registers. The local doctrine checks it.
 *
 * FAIL-CLOSED, like every other authoring path here. Ops are applied as ONE
 * atomic batch through the same `author.ops` leaf the panels and the CLI use, so
 * a rejected round changes nothing. A round that produces a world the doctrine
 * rejects is fed its own errors and asked to fix them — up to `MAX_ROUNDS` — and
 * an empty-ops "correction" is refused as a retreat rather than accepted as
 * success, because an empty edit repairs nothing.
 *
 * PAINT, THEN PROBE, THEN AUTHOR: a first frame is painted
 * from the premise BEFORE a single state of prose exists, a vision model
 * (when one is configured) is asked to detect several NAME VARIANTS per
 * candidate object against that exact frame, and anchor / merge /
 * discriminate / drop selection (`selectVerifiedObjects`,
 * `src/provider/vision/probe.ts`) turns those raw boxes into which objects
 * are safe to ground on — not "it returned a box" but "a box that points
 * ONLY at it". An object that missed, or that only hit where a RIVAL object
 * also anchors, is dropped before the author ever sees it — the author
 * cannot build an interaction on an object the player could never click, or
 * would click the wrong thing for. With no vision axis configured (or no
 * image axis to paint a frame to probe in the first place) the step is
 * skipped outright and the kernel authors exactly as it always did:
 * ungrounded, and the result says so plainly (`probed: []`).
 */

import { extractJson, ReplyParseError } from './reply'
import { PUBLIC_OPS, toPublicOps, runDoctrine, unwrapWorldDoc, verifyWorld, critique } from '../../world'
import type { Diagnostic, PublicOp, SMEventAnchor, SMWorld, WorldStore } from '../../world'
import {
  selectVerifiedObjects,
  type ImageProvider,
  type LLMMessage,
  type LLMProvider,
  type ProbeCandidate,
  type VerifiedObject,
  type VisionProvider,
} from '../../provider'
import type { ToolOutcome } from '../../tool'

/** How many times the agent may be handed its own errors before giving up. */
const MAX_ROUNDS = 4

/**
 * Room for a REASONING model to think before it answers.
 *
 * This was 300, which is generous for a JSON array of eight nouns and useless
 * in practice: a reasoning model spends its budget on reasoning first, so the
 * call came back `finish_reason: "length"` with NO content at all, the parse
 * failed, the candidate list came back empty, and the probe silently skipped —
 * a world reported as grounded that had never been looked at. Caught by running
 * it against a real model; the same class of trap as any thinking-budget cap.
 */
/**
 * Room for five to eight states of dense prose plus the ops envelope. The edit
 * path gets by on 4096 because it rewrites one field; a whole graph does not
 * fit in that, and a truncated reply is unparseable JSON rather than a short
 * world.
 */
const MAX_TOKENS = 16000

const CANDIDATE_MAX_TOKENS = 4000
/** A ceiling on the label fan-out, so a probe cannot spend more than
 *  intended even on a pathological candidate list. */
const MAX_PROBES = 40
/** How many `vision.detect` calls run at once. Small on purpose: this is a
 *  bring-your-own endpoint — often a local process on someone's laptop, not a
 *  fan-out-friendly hosted API. */
const PROBE_CONCURRENCY = 4

export interface GenerationResult {
  /** What the agent says it built, for the author to read. */
  reply: string
  /** Doctrine diagnostics on the finished graph. Empty is a clean world. */
  diagnostics: Diagnostic[]
  states: number
  events: number
  /** The title the kernel gave the world. Empty when it declined to name it. */
  name: string
  /** True when a first frame was painted and attached to the entrance. */
  anchored: boolean
  /** How many authored anchors were stamped with the probe's MEASURED geometry
   *  (`minProximity`/`expectedAspect`) — the numbers the play-time chip rules
   *  gate on. 0 with a non-empty `probed` means the kernel anchored on nouns
   *  the probe never verified. */
  grounded: number
  /** How many rounds it took. >1 means it corrected itself. */
  rounds: number
  /**
   * Every candidate object the vision model was asked about, one entry per
   * candidate the language model proposed — hit or miss, dropped or
   * verified. `hits` is the raw box count found across ALL of that
   * candidate's NAME VARIANTS (0 means every variant missed). `aliases` is
   * populated only when the candidate survived `selectVerifiedObjects`'
   * full anchor/merge/discriminate selection (`src/provider/vision/probe.ts`)
   * — the same clean synonyms offered to the author as acceptable alternates
   * in the grounding block below; empty means either nothing hit, or it hit
   * only where a rival object also anchors and was rejected as promiscuous.
   * Empty whenever nothing was actually probed: no vision axis configured,
   * no image axis to paint a frame in the first place, or the candidate-noun
   * call itself came back empty.
   */
  probed: { label: string; hits: number; aliases: string[] }[]
  /**
   * Why `probed` is empty, when it is empty for a reason worth saying out loud.
   * A world nobody could ground and a world nobody TRIED to ground are not the
   * same claim, and neither is "the detector found none of it".
   */
  probeNote?: string
  /** Why there is no opening frame, when there is none. Empty when one painted. */
  paintNote?: string
  /** Set when the agent refused to guess and asked instead; nothing was applied. */
  question?: string
}

export class GenerationError extends Error {
  constructor(message: string, readonly diagnostics: Diagnostic[] = [], readonly raw?: string) {
    super(message)
    this.name = 'GenerationError'
  }
}

/** The op vocabulary, derived from the store's own list so it cannot drift. */
const OP_LIST = PUBLIC_OPS.join(', ')

const SYSTEM = `You are the world kernel. You author a complete, playable world from one premise.

A world is a small state machine. A STATE is a place the camera can be, and its prose is
what the camera sees there. An EVENT is what a player does. The world is played by a video
world model: it renders your prose literally, frame by frame.

You reply with STRICT JSON and nothing else:
{"name": "<the world's title — two or three words, evocative, no quotes>",
 "reply": "<two or three sentences telling the author what you built>", "ops": [ ... ]}
If — and only if — the premise is ambiguous in a way that changes the STRUCTURE of the
world, reply instead with {"reply": "...", "question": "<one specific either/or>", "ops": []}.
Do not ask about taste, names or details you can simply choose.

THE SHAPE TO BUILD
- 5 to 8 states. Fewer is a demo, more is a maze.
- 6 to 12 events.
- At least one real branch: a state two different events lead out of, to different places.
- At least one WIN ending and at least one LOSE ending, both reachable.
- Every state reachable from the entrance. Set the entrance explicitly.
- snake_case ids and event names, lowercase, no spaces.

SUBJECT LOCK — the anti-drift rule
Decide ONE subject sentence describing who the player is and what they look like, and ONE
closing atmosphere sentence. Reuse both VERBATIM — byte-identical — at the start and end of
EVERY state's base. A world model that reads a slightly different subject each state draws a
slightly different creature each state.

PROSE DENSITY — every state's base
Write it as a shot, not a label: open by framing the video ("A third-person rear-view shot of
<subject>…"), then the subject's pose and what is in frame, then the environment in DEPTH —
what is close, what is mid-distance, what is far — and close with the atmosphere tail. Rich
and cinematic. A one-line stub renders flat and empty.
Give every state two or three "ambient" details as well — the small moving things that make a
shot alive rather than a photograph (drifting silt, a swinging lamp, gulls). They are a
separate list, not sentences inside base.

POSITIVE PROSE ONLY
Never write what is absent. "no fish", "not dark", "without walls" all summon the thing they
deny, because the model renders what it reads. Say what IS there. (The camera register is the
one exception and you are not authoring camera locks here.)

EVENT KIND
- "transition" carries the player INTO another state and re-seeds the scene. It needs "to".
- "override" is a sustained overlay on the state the player is already in; when it ends the
  unchanged state resumes. It must NOT carry "to".
- Default to override for anything that should leave the scene standing. Use transition for
  real movement or real change.
- An override must never kill, destroy or permanently change anything: the state it overlays
  comes back untouched, which would resurrect whatever it killed. Make those transitions.

CONSEQUENCE
Every action resolves. If the player is displaced (a leap, a dive, a fall) the world it lands
in is a state that exists. If something is transformed (opened, broken, lit) the state it
transitions to shows the world transformed. Momentary things — a glance, a flicker — are
overrides that revert.

THE OPS
Every op is one of: ${OP_LIST}.
{"op":"add_state","id":"<snake_case>","base":"<rich prose>","camera":{"static":"<framing that holds>","dynamic":"<motion the camera adds>"},"movement":{"static":"<the subject at rest>","dynamic":"<the subject moving>"},"ambient":["<detail>", ...]}
{"op":"update_state","id":"<existing>","patch":{"base":"<prose>","ending":{"kind":"win"|"lose","title":"<short>","subtitle":"<one line>"}}}
{"op":"delete_state","id":"<existing>"}
{"op":"add_event","name":"<snake_case>","kind":"transition","from":["<state id>"],"to":"<state id>","base":"<what the camera sees as it happens>","phases":[...optional...],"landWhen":{...optional...}}
{"op":"add_event","name":"<snake_case>","kind":"override","from":["<state id>"],"detail":"<one sustained overlay sentence>"}
{"op":"update_event","name":"<existing>","patch":{"base":"...","detail":"...","to":"<state>","hotkey":"<single letter>","anchor":{"label":"<plain object the player clicks>"}}}
{"op":"delete_event","name":"<existing>"}
{"op":"set_entrance","state":"<existing state id>"}
{"op":"add_variant","state":"<id>","label":"B","base":"<alternate prose>"}
{"op":"remove_variant","state":"<id>","label":"B"}
{"op":"set_story","logline":"<one sentence>"}
{"op":"set_subject","subject":"<appearance of the one thing the camera follows>"}

An ending is set with update_state's patch.ending — there is no separate ending op.
ANCHORS — what the player CLICKS
Give most transitions an anchor: the object in the picture that fires it. Without one the
event is reachable only from the beat rail, and a world model's picture becomes scenery the
player reads rather than a place they touch.
  {"op":"update_event","name":"<event>","patch":{"anchor":{"label":"<the object>"}}}
Anchor labels are DETECT queries for a vision model: use plain common nouns ("door", "stone",
"fish"), never fancy names, or nothing is found. The noun must be something the state's OWN
prose actually puts in frame.

CHOREOGRAPHY (optional, on a transition) — "phases"
A move the player can SEE happen (crossing a threshold, climbing onto something, descending
into the dark) is told one beat at a time, because the model swaps prompts at a chunk
boundary: one prompt describing the whole move lands the ending while the pixels still show
the start.
  "phases":[{"base":"<beat 1, its own whole scene>","camera":"<framing for THIS beat only>","minMs":5000}, ...]
Every beat carries its OWN camera. A camera that says "as it steps out" appended to beat one
teleports the model straight to the end of the move. Two or three beats; only where the
movement is worth watching.

ARRIVAL (optional, on a transition) — "landWhen"
What the picture must SHOW before the destination is allowed to land, instead of a timer:
  "landWhen":{"minLuminance":90}          the scene became bright (dark -> daylight)
  "landWhen":{"maxLuminance":30}          the scene went dark (daylight -> a tunnel)
  "landWhen":{"maxMotion":8}              the scene SETTLED — the physical signature of arriving
                                          (a live world model never stops: it idles around 4 and
                                           runs about 24 while it draws the place you are going,
                                           so 8 means settled, and anything at or under 4 can
                                           never be reached while the destination is being drawn)
  "landWhen":{"label":"door","minExtent":0.15}   an object fills enough of the frame
Add "auto":true only alongside a luminance or motion threshold: an auto zone completes during
free roam with no press, and the runtime honours it for those signals only. If a pair of
transitions goes there-and-back, keep the bright band and the dim band apart or the world
oscillates between them on its own.

LOCKS — "grants", "requires", "lockedHint" (on events)
A world where every door is already open is a slideshow with buttons. At least one event
should be shut until the player has done something else:
  {"op":"update_event","name":"<the act that earns it>","patch":{"grants":["<flag>"]}}
  {"op":"update_event","name":"<the shut one>","patch":{"requires":["<flag>"],
     "lockedHint":"<what the player is still missing, in the world's voice>"}}
The flag is a plain snake_case token nobody sees ("has_lamp", "cut_the_rope"). A flag that
is REQUIRED but never GRANTED is refused — every lock needs its key somewhere earlier in the
graph. The hint is prose the player reads when they try the locked thing, so write what they
would notice, not what the machine is checking.

NARRATION — "narration", on the entrance and at least two other states
One line shown to the player on arrival, in the world's voice. It is NOT sent to the model,
so it is the one place you may name what the prose cannot show — a thought, a sound, a
memory. The picture cannot say "he has been here before"; this can.
  {"op":"update_state","id":"<state>","patch":{"narration":"<one line>"}}

THE WORLD ITSELF — one logline, one subject
  {"op":"set_story","logline":"<one sentence: who, doing what, against what>"}
  {"op":"set_subject","subject":"<the one creature, person or vehicle the camera follows>"}
The SUBJECT is a lock against drift: a world model draws a slightly different creature every
time it reads a slightly different description, so the subject is stated ONCE here and reused
everywhere instead of being re-improvised per state. Write it as an appearance, not a name —
"a beaver in a brass diving helmet", never "Barnaby".

A MISSION (optional, and worth it when the premise implies a GOAL rather than a place to
wander) is authored in ONE op and compiles itself into states, events, flags and endings:
{"op":"add_mission","id":"<snake_case>","title":"<the quest's name>",
 "objectives":[
   {"id":"<snake_case>","text":"<the line the player reads>",
    "action":"<how the doing LOOKS while it plays — full density, like an event base>",
    "location":"<state id — created if new>","base":"<prose for it, if new>",
    "grounded":{"target":"<plain noun the player points at>","confirm":"<the visual proof it landed>"},
    "outcome":"<the world AFTER the action — a kill resolves to a NEW state, never a re-seed>",
    "fail":{"name":"<a tempting wrong move>","action":"<how it looks>","outcome":"<the world, ruined>","title":"<CARD LINE>"}}
 ]}
Objectives chain themselves: each one requires the previous one's flag, the last resolves into
a terminal scene carrying the win card, and every "fail" becomes a sibling action that ends the
run. Give a mission 3-5 objectives and at least one real stake. Do NOT hand-author the states
and events a mission covers — emit the mission and let it compile.

Emit the whole world in ONE ops array, in an order that works: add every state first, then
set the entrance, then add the events, then update states that carry endings.`

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}


/** A stable key for one diagnostic, so pre-existing dirt is not blamed on a round. */
function key(d: Diagnostic): string {
  return `${d.lint}|${d.path}`
}

function describeErrors(applyError: string | undefined, diagnostics: Diagnostic[]): string {
  const lines: string[] = []
  if (applyError) lines.push(`- ${applyError}`)
  for (const d of diagnostics) lines.push(`- the doctrine rejected [${d.lint}] at ${d.path}: ${d.message}`)
  return lines.join('\n')
}

/** The bridge shape this agent needs — the same one the app's ClientContext exposes. */
export interface ToolRunner {
  run(path: string, input: Record<string, unknown>, opts?: { origin?: 'app' | 'agent' }): Promise<ToolOutcome>
}

/**
 * Apply one batch. The app hands in its tool bridge so the write shows up in the
 * action log as `author.ops` like every other write; the `author.generate` LEAF
 * hands in nothing, because it is already running inside a tool call and
 * reaching back through the tree from a leaf would be a module cycle. Both end
 * at the same store method with the same atomicity.
 */
async function applyBatch(
  store: WorldStore,
  tools: ToolRunner | undefined,
  worldId: string,
  ops: ReturnType<typeof toPublicOps>,
): Promise<{ ok: true } | { ok: false; message: string; diagnostics: Diagnostic[] }> {
  if (tools) {
    const outcome = await tools.run('author.ops', { world: worldId, ops }, { origin: 'agent' })
    if (outcome.ok) return { ok: true }
    return { ok: false, message: outcome.error.message, diagnostics: outcome.error.diagnostics }
  }
  try {
    const scene = await store.getScene(worldId)
    await store.applyOps(worldId, ops, scene.rev)
    return { ok: true }
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e)
    return { ok: false, message, diagnostics: [] }
  }
}

/**
 * Author a whole world into `worldId` from `premise`.
 *
 * The world must already exist (created blank by `world.create`) — this fills
 * it. Throws GenerationError when no round produced a graph the doctrine
 * accepts; the caller keeps a world with its opening state and a reason to show.
 */
export async function runGeneration(opts: {
  llm: LLMProvider
  store: WorldStore
  tools?: ToolRunner | undefined
  /** Paints the world's first frame, when the author configured one. */
  image?: ImageProvider | undefined
  /**
   * Verifies candidate anchor labels against the painted frame, when the
   * author configured one. See the file header for why this now runs BEFORE
   * authoring rather than after.
   */
  vision?: VisionProvider | undefined
  worldId: string
  premise: string
  /** A SHORT scene for the painter, when the premise is too long to draw.
   *  Defaults to the premise, which is what a one-sentence premise wants. */
  scene?: string | undefined
  signal?: AbortSignal | undefined
  /** Called as each step starts, for a surface that can show it. See
   *  `ToolContext.progress` for why this exists rather than one envelope. */
  progress?: ((note: string) => void) | undefined
}): Promise<GenerationResult> {
  const { llm, store, tools, image, vision, worldId, premise, signal } = opts
  // Say what is happening while it happens. Absent on every surface that
  // cannot show it (the CLI, the agent), which is why every call is optional
  // rather than a required argument threaded through four functions.
  const say = opts.progress ?? ((): void => {})

  // STEP 1 — paint, before a word is authored. Null when there is no image
  // axis, or painting failed; everything below degrades gracefully on that.
  if (image?.isConfigured()) say('Painting the first frame…')
  // WHAT THE PAINTER READS is not always what the kernel reads. An image
  // prompt must be short — this is the only place the text gets distilled. A
  // premise IS short, so it doubles as the scene; a chapter's brief is a
  // logline, a cast, places, an atmosphere and a numbered beat list, and
  // handing that to an image model returns nothing (measured: a correct
  // world with a black screen). So a caller that has a better scene line
  // passes one.
  const { frame: painted, note: paintNote } = await paintFirstFrame(image, opts.scene?.trim() || premise, signal)
  if (paintNote) say(paintNote)

  // STEP 2 — probe. Only possible once there IS a frame, and only worth doing
  // once there is a vision axis to ask. `groups` is the language model's own
  // guess at what the frame would show, each as a small group of alternate
  // NAME VARIANTS for the same object — nothing past this point trusts that
  // guess; it is only ever a list to probe against the real pixels. The raw
  // per-variant hits then go through `selectVerifiedObjects` — full
  // anchor/merge/discriminate/drop selection (`src/provider/vision/probe.ts`)
  // — so a candidate that only hit where a RIVAL object also anchors is
  // rejected, not accepted on a bare "it returned a box".
  let probed: { label: string; hits: number; aliases: string[] }[] = []
  let verified: VerifiedObject[] = []
  let probeNote = ''
  if (painted && vision && vision.isConfigured()) {
    say('Looking for objects to ground…')
    const groups = await proposeCandidates(llm, premise, signal)
    if (groups.length === 0) {
      // A probe that could not even ask must not look like a probe that found
      // nothing, and neither may look like a world nobody tried to ground.
      probeNote = 'the model proposed no candidate objects, so the frame was never probed'
    } else {
      say(`Probing the frame for ${groups.map((g) => g.object).join(', ')}…`)
      const probedCandidates = await probeLabels(vision, painted.b64, groups, signal)
      verified = selectVerifiedObjects(probedCandidates)
      if (verified.length > 0) say(`Verified in the frame: ${verified.map((v) => v.label).join(', ')}`)
      probed = probedCandidates.map((c) => ({
        label: c.label,
        hits: c.variants.reduce((sum, v) => sum + v.boxes.length, 0),
        aliases: aliasesFor(c, verified),
      }))
      if (probed.every((p) => p.hits === 0)) {
        probeNote = `nothing proposed was found in the frame (${groups.map((g) => g.object).join(', ')}) — the graph is ungrounded`
      } else if (verified.length === 0) {
        // Something hit — just never cleanly enough to survive selection:
        // every hit either collided with a rival object's anchor or missed
        // its own by too much. Different claim than "found nothing", so it
        // gets its own words.
        probeNote = 'objects were detected but none passed verification — every hit collided with a rival object or missed its own anchor — the graph is ungrounded'
      }
    }
  } else if (painted) {
    // Every other outcome above has careful words for itself. This one had none,
    // because the condition was `painted && vision` — so a caller that passed NO
    // vision at all fell straight through in silence. That is the case that hurt:
    // a live recording showed an entrance whose painted frame (an interior) and
    // whose authored prose (a footbridge) described different places, and nothing
    // anywhere said the graph had been written without looking at its own frame.
    probeNote = vision
      ? 'a vision axis is present but not configured, so the frame was never probed'
      : 'no vision model was supplied, so the frame was painted and never looked at — the graph was written without seeing its own first frame, and may describe somewhere else'
  }

  // Diagnostics the world already carried. A generation round is judged on what
  // IT introduced, not on the state of the blank world it was handed.
  const before = await readWorld(store, worldId)
  const baseline = new Set(runDoctrine(before).map(key))

  // The world is not empty: `world.create` laid down one stub state holding the
  // premise. Saying so is the difference between a kernel that builds AROUND
  // the stub — leaving it orphaned, which the doctrine then flags — and one
  // that takes it over.
  const existing = Object.keys(before.scene?.states ?? {})
  const stub = existing.length > 0 ? existing.join(', ') : ''
  const opening = stub
    ? `\n\nThis world already contains ${existing.length === 1 ? 'one state' : 'these states'}: ${stub}. ` +
      'Do not leave it stranded: either make it the entrance and REWRITE its base with update_state ' +
      'so it carries real prose, or delete_state it once your own entrance exists.'
    : ''

  // STEP 3 — the grounding block. Only objects `selectVerifiedObjects`
  // actually verified are ever named to the author, and it is told this is
  // a closed set: an indistinct object is dropped before the author ever
  // sees it, by never mentioning it here at all. Each is named by its
  // discriminating PRIMARY label; any other clean variant is offered right
  // alongside as an acceptable alternate, so a small wording difference in
  // the authored anchor still detects at play time.
  const objectList = verified
    .map((v) => (v.aliases.length > 0 ? `${v.label} (also acceptable: ${v.aliases.join(', ')})` : v.label))
    .join('; ')
  const grounding =
    verified.length > 0
      ? '\n\nTHESE OBJECTS ARE CONFIRMED PRESENT in the first frame, verified against it by a vision ' +
        `model just now: ${objectList}.\n` +
        'ANCHOR THE WORLD ON THEM. An anchor turns an event into something the player can POINT AT — ' +
        'the object is found in the live frame and drawn as a target they click, instead of a line of ' +
        'text on a menu. Give an anchor to every event whose action is aimed at one of these objects. ' +
        'A parenthesized "(also acceptable: ...)" lists other exact nouns THE SAME detector already ' +
        'confirmed for that object — use the object\'s own noun or ONE of those, verbatim and alone, ' +
        'never the parenthesis itself and never a synonym nobody confirmed. An anchor on anything else ' +
        'is invisible at play time: the detector will not find it and the player will never be able to ' +
        'click it. Set one with ' +
        '{"op":"update_event","name":"<event>","patch":{"anchor":{"label":"<one exact noun from above>"}}}.'
      : ''

  const messages: LLMMessage[] = [
    { role: 'system', content: SYSTEM },
    { role: 'user', content: `Premise: ${premise}${opening}${grounding}\n\nAuthor the world.` },
  ]

  let lastRaw = ''
  let lastErrors: Diagnostic[] = []
  // WHY each round ended. Four of the six `continue`s below happen BEFORE the
  // doctrine runs, so `lastErrors` can be three rounds stale by the time the
  // loop gives up — and the final throw said "the doctrine rejects it" while
  // holding warnings from round 1 that had nothing to do with the failure. A
  // measurement run read that message and blamed the wrong rule. The trail is
  // what the error reports now, so the reason it gives is the reason it had.
  const trail: string[] = []

  for (let round = 1; round <= MAX_ROUNDS; round += 1) {
    // Rounds 2+ are the kernel CORRECTING itself against the doctrine, which
    // is a different thing to be waiting on than the first draft.
    say(round === 1 ? 'Authoring the graph…' : `Correcting the graph (round ${round} of ${MAX_ROUNDS})…`)
    const raw = await llm.complete({ json: true, temperature: 0.7, maxTokens: MAX_TOKENS, messages, signal })
    lastRaw = raw

    let parsed: unknown
    try {
      parsed = extractJson(raw)
    } catch (e) {
      if (!(e instanceof ReplyParseError)) throw e
      // An unparseable round is a round that proposed nothing — press again.
      messages.push({ role: 'assistant', content: raw })
      messages.push({
        role: 'user',
        content: 'That was not valid JSON. Reply with ONLY the {"reply","ops"} object, no prose around it.',
      })
      trail.push(`round ${round}: the answer was not valid JSON`)
      continue
    }

    const obj = isRecord(parsed) ? parsed : {}
    const reply = typeof obj['reply'] === 'string' && obj['reply'].trim() ? obj['reply'].trim() : 'Built the world.'

    // THE ASK GATE. A structural ambiguity is worth one question; guessing at it
    // produces a world the author has to take apart. Nothing is applied.
    const question = typeof obj['question'] === 'string' ? obj['question'].trim() : ''
    if (question) {
      return { reply, diagnostics: [], states: 0, events: 0, rounds: round, name: '', anchored: false, grounded: 0, probed, ...(probeNote ? { probeNote } : {}), question }
    }

    let ops: ReturnType<typeof toPublicOps>
    try {
      ops = toPublicOps(obj['ops'])
    } catch (e) {
      messages.push({ role: 'assistant', content: raw })
      messages.push({
        role: 'user',
        content: `Those ops were REJECTED:\n- ${e instanceof Error ? e.message : String(e)}\n\nRe-emit the FULL list using only the documented ops.`,
      })
      trail.push(`round ${round}: the ops were not in the documented vocabulary`)
      continue
    }

    // ANTI-RETREAT. An empty ops array validates trivially; accepting it would
    // report success for a world nobody authored.
    if (ops.length === 0) {
      messages.push({ role: 'assistant', content: raw })
      messages.push({
        role: 'user',
        content: 'You returned no ops. An empty edit authors nothing — emit the complete world.',
      })
      trail.push(`round ${round}: the model returned no ops`)
      continue
    }

    // One atomic batch, through the same store call every other writer ends at.
    const applied = await applyBatch(store, tools, worldId, ops)
    if (!applied.ok) {
      messages.push({ role: 'assistant', content: raw })
      messages.push({
        role: 'user',
        content:
          `Those ops were REJECTED:\n${describeErrors(applied.message, applied.diagnostics)}\n\n` +
          'Re-emit the FULL list — keep every op that was fine and fix ONLY what is flagged. Do not drop ops ' +
          'and do not return an empty array; an empty edit fixes nothing. Output the complete corrected JSON.',
      })
      trail.push(`round ${round}: the store refused the batch — ${applied.message ?? 'see diagnostics'}`)
      continue
    }

    const after = await readWorld(store, worldId)
    say('Checking it against the doctrine…')
    const fresh = runDoctrine(after).filter((d) => !baseline.has(key(d)))
    const errors = fresh.filter((d) => d.severity === 'error')
    lastErrors = fresh
    const ungrounded = ungroundedAnchors(after, verified)

    if (ungrounded.length > 0) {
      const names = verified.map((v) => v.label).join(', ')
      messages.push({ role: 'assistant', content: raw })
      messages.push({
        role: 'user',
        content:
          `These anchors name objects the detector did NOT find in the first frame:\n` +
          ungrounded.map((u) => `- ${u}`).join('\n') +
          `\n\nAn anchor is a live DETECT query — one of these exact nouns, or the player can never ` +
          `click it: ${names}. Re-emit update_event ops fixing ONLY those anchors, against the world ` +
          'as it now stands. Do not re-add what is already there.',
      })
      continue
    }

    // THE HARD TEST. The doctrine answers "is anything WRONG"; this answers "is
    // it worth playing" — and a world can pass every lint while being empty,
    // because nothing in an empty room is incorrect. Two runs proved that on
    // camera a day apart (one state and no events; six states and no entrance
    // prose), and each was patched with a hand-rolled check. `verifyWorld` is
    // those checks generalised into one scored gate that enforces exactly what
    // the prompt above promises and merely ADVISES beyond it.
    const verdict = verifyWorld(after, { premise, lintErrors: errors.length })
    if (errors.length === 0 && !verdict.pass && round < MAX_ROUNDS) {
      messages.push({ role: 'assistant', content: raw })
      messages.push({ role: 'user', content: critique(verdict) })
      trail.push(`round ${round}: authored, but not worth playing yet (${verdict.score}/100)`)
      continue
    }
    if (errors.length === 0 && !verdict.pass) {
      throw new GenerationError(
        `The model answered ${round} times and never authored a world worth playing (${verdict.score}/100): ` +
          verdict.issues.slice(0, 3).join(' · '),
        [],
        raw,
      )
    }

    if (errors.length === 0) {
      const scene = after.scene
      const name = typeof obj['name'] === 'string' ? obj['name'].trim() : ''
      // The world was called by its premise until now, because the store had
      // nothing better to call it. The kernel names it — a world in a list
      // wants a title, not the sentence that made it.
      if (name) await store.updateWorld(worldId, { name }).catch(() => undefined)
      // STEP 4 — attach the already-painted frame to whichever state the
      // kernel chose as the entrance. Nothing is painted here; that already
      // happened in step 1, before this world existed in any real form.
      const anchored = painted ? await attachAnchor(store, worldId, after, painted) : false
      // The probe MEASURED each verified object's geometry; until now that
      // measurement died with the probe and the authored anchor carried a bare
      // label. Stamp it on — it is what the player's chip rules gate on, and
      // an anchor with no measured proximity arms the moment it is centred no
      // matter how far away it is.
      const grounded = await groundAnchorGeometry(store, tools, worldId, after, verified)
      return {
        reply,
        diagnostics: fresh,
        states: Object.keys(scene?.states ?? {}).length,
        events: (scene?.events ?? []).length,
        rounds: round,
        name,
        anchored,
        grounded,
        probed,
        ...(probeNote ? { probeNote } : {}),
        ...(paintNote ? { paintNote } : {}),
      }
    }

    messages.push({ role: 'assistant', content: raw })
    messages.push({
      role: 'user',
      content:
        `The world was written but the doctrine rejects it:\n${describeErrors(undefined, errors)}\n\n` +
        'Fix ONLY the flagged fields with update_state / update_event ops against the world as it now ' +
        'stands. Do not re-add what is already there, and do not return an empty array. ' +
        'If a [budget] error is shown, that field\'s assembled prose is over 1900 characters — shorten ' +
        'THAT field and leave the rest. Output the complete {"reply","ops"} JSON.',
    })
    trail.push(`round ${round}: the doctrine rejected the world — ${errors.map((d) => d.lint).join(', ')}`)
  }

  throw new GenerationError(
    `the kernel gave up after ${MAX_ROUNDS} rounds. What happened:\n${trail.map((t) => `  · ${t}`).join('\n')}`,
    // Only the doctrine's own diagnostics, and only when the doctrine is what
    // ended the last round. Handing back stale warnings from an earlier round
    // is what sent a measurement run after the wrong rule.
    /doctrine rejected/.test(trail[trail.length - 1] ?? '') ? lastErrors : [],
    lastRaw,
  )
}

/**
 * Paint the world's first frame from the raw premise — BEFORE a single word
 * of the graph is authored.
 *
 * This is the ANCHOR: image-seeded world models will not start generating
 * without one, and even those that will start from prose alone drift less
 * when they are given a picture to hold. Painting from the premise rather
 * than from authored prose (the OLD order this replaced) is what makes a real
 * probe possible in the first place — there is nothing to verify a label
 * against until a frame exists.
 *
 * Failure is not fatal: a world with no first frame is still a world, and
 * both the probe and the attach step below degrade gracefully when this
 * returns null.
 */
/**
 * The opening frame, and WHY there is not one when there is not one.
 *
 * This used to `catch { return null }`, so a painter that threw looked exactly
 * like no painter at all — and the difference matters enormously, because some
 * image-seeded world models will not generate from prose alone. Three separate
 * live runs died on a black screen with a correct world behind it, and none of
 * them could say why, because the reason was discarded one line after it
 * arrived.
 *
 * `note` is for a human: it is shown in the studio and printed by the CLI, so a
 * failed paint reads as a sentence rather than as an absence.
 */
export async function paintFirstFrame(
  image: ImageProvider | undefined,
  premise: string,
  signal?: AbortSignal | undefined,
): Promise<{ frame: { b64: string; mime: string } | null; note: string }> {
  if (!image || !image.isConfigured()) {
    return { frame: null, note: 'no image model is configured, so nothing was painted' }
  }
  try {
    const frame = await image.generate(
      `A third-person rear-view shot establishing the opening scene of a world about: ${premise}`,
      signal,
    )
    if (!frame) return { frame: null, note: 'the image model returned no picture and no error' }
    return { frame, note: '' }
  } catch (e) {
    const why = e instanceof Error ? e.message : String(e)
    return { frame: null, note: `the first frame could not be painted: ${why.slice(0, 200)}` }
  }
}

const CANDIDATE_SYSTEM = `You help ground a world in reality before it is built. Given a one-sentence
premise, name the SALIENT, CONCRETE objects a painted first frame of it would plausibly show — things
large and fixed enough that a player could walk up to and interact with one. Ignore the player-
character, the ground, the sky, and small scattered clutter.

For EACH object, propose 2 to 4 DETECT-LABEL VARIANTS: alternate plain noun phrases an open-vocabulary
object detector might match it under. Detectors are fussy about exact wording, so vary vocabulary and
specificity — a plain everyday noun, a concrete visual noun, a compound noun. Example: {"object":"door",
"variants":["door","doorway","wooden door"]}. Each variant is ONE to THREE words, lowercase, no articles,
no adjectives, no color words — a plain, common, open-vocabulary DETECT query ("door", "torch", "car",
"shrine", "console"), never a fancy or abstract name a detector would never match.

Reply with STRICT JSON and nothing else: {"objects": [{"object": "<plain noun>", "variants": ["<variant>",
...]}, ...]}. 3 to 8 objects.`



/**
 * Ask the language model what a painted frame of this premise would
 * plausibly show — a short list of objects, each as a small group of
 * alternate NAME VARIANTS for the same thing, to hand the vision model. Not
 * a promise any of it is actually there: nothing past this point trusts
 * this guess, it is only ever a list to probe against the real pixels.
 * One-shot and fail-soft: an empty or unparseable reply just means nothing
 * gets probed, and the kernel authors ungrounded exactly as it does with no
 * vision axis at all.
 */
export async function proposeCandidates(
  llm: LLMProvider,
  premise: string,
  signal?: AbortSignal | undefined,
): Promise<{ object: string; variants: string[] }[]> {
  let raw: string
  try {
    raw = await llm.complete({
      json: true,
      temperature: 0.5,
      maxTokens: CANDIDATE_MAX_TOKENS,
      messages: [
        { role: 'system', content: CANDIDATE_SYSTEM },
        { role: 'user', content: `Premise: ${premise}` },
      ],
      signal,
    })
  } catch {
    return []
  }
  let parsed: unknown
  try {
    parsed = extractJson(raw)
  } catch {
    return []
  }
  const obj = isRecord(parsed) ? parsed : {}
  const list = Array.isArray(obj['objects']) ? obj['objects'] : []
  const seen = new Set<string>()
  const out: { object: string; variants: string[] }[] = []
  for (const entry of list) {
    // Tolerate the flat shape too: a model that answers with bare strings has
    // still named something worth probing, and one variant is a valid group.
    const name = typeof entry === 'string' ? entry : isRecord(entry) && typeof entry['object'] === 'string' ? entry['object'] : ''
    const label = name.trim().toLowerCase()
    if (!label || seen.has(label)) continue
    seen.add(label)
    const rawVariants = isRecord(entry) && Array.isArray(entry['variants']) ? entry['variants'] : []
    const variants: string[] = []
    for (const v of [label, ...rawVariants]) {
      if (typeof v !== 'string') continue
      const clean = v.trim().toLowerCase()
      if (clean && !variants.includes(clean)) variants.push(clean)
    }
    out.push({ object: label, variants })
    if (out.length >= 8) break
  }
  return out
}


/**
 * Fan `vision.detect` out over every (object, variant) pair — several NAME
 * VARIANTS per object are probed and `selectVerifiedObjects` discriminates
 * between them, rather than trusting a single guess. Bounded concurrency,
 * capped at `MAX_PROBES` total; a well-behaved `proposeCandidates` reply
 * (3-8 objects × 2-4 variants) never gets close. A failed `detect()` call
 * (network, timeout, anything) counts as a miss rather than throwing — one
 * flaky variant must not sink the whole probe. Returns one `ProbeCandidate`
 * per group, in `groups` order, ready for `selectVerifiedObjects`.
 */
export async function probeLabels(
  vision: VisionProvider,
  imageB64: string,
  groups: { object: string; variants: string[] }[],
  signal?: AbortSignal | undefined,
): Promise<ProbeCandidate[]> {
  // One unit of work per VARIANT, because that is what the detector answers
  // and what the selector discriminates between — flattened here so the whole
  // fan-out shares one budget and one concurrency limit.
  const jobs: { group: number; variant: string }[] = []
  groups.forEach((g, gi) => {
    for (const variant of g.variants) jobs.push({ group: gi, variant })
  })
  const capped = jobs.slice(0, MAX_PROBES)
  const out: ProbeCandidate[] = groups.map((g) => ({ label: g.object, variants: [] }))
  let next = 0
  async function worker(): Promise<void> {
    for (;;) {
      const i = next
      next += 1
      if (i >= capped.length) return
      const job = capped[i]
      if (job === undefined) continue
      const target = out[job.group]
      if (target === undefined) continue
      try {
        const boxes = await vision.detect(imageB64, job.variant, signal)
        target.variants.push({ label: job.variant, boxes })
      } catch {
        // A flaky call is a miss, not a thrown probe: one bad label must not
        // sink the grounding of every other object in the frame.
        target.variants.push({ label: job.variant, boxes: [] })
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(PROBE_CONCURRENCY, capped.length) }, () => worker()))
  return out
}

/** The clean alternate names selection kept for a candidate, if it survived. */
export function aliasesFor(candidate: ProbeCandidate, verified: VerifiedObject[]): string[] {
  const names = new Set([candidate.label, ...candidate.variants.map((v) => v.label)])
  const match = verified.find((v) => names.has(v.label) || v.aliases.some((a) => names.has(a)))
  return match ? match.aliases : []
}

/**
 * Attach an already-painted frame to the entrance the kernel just authored.
 * The painting happened up front (`paintFirstFrame`, above, run before a
 * single state existed); this only wires the bytes it already produced onto
 * whichever state ended up as the entrance — unknowable until authoring
 * finishes, since the kernel is the one that chooses it.
 */
async function attachAnchor(
  store: WorldStore,
  worldId: string,
  world: SMWorld,
  painted: { b64: string; mime: string },
): Promise<boolean> {
  const entranceId = world.entrance?.state
  if (!entranceId) return false
  try {
    const scene = await store.getScene(worldId)
    await store.setEntrance(
      worldId,
      { state: entranceId, image: { label: 'the first frame', src: `data:${painted.mime};base64,${painted.b64}` } },
      scene.rev,
    )
    return true
  } catch {
    return false
  }
}

/**
 * Copy the probe's MEASURED geometry onto every anchor that names a verified
 * object: the detector's own alias list, plus `minProximity` / `expectedAspect`
 * where the probe measured them (thin objects and objects that collided with a
 * neighbour — `provider/vision/probe.ts`).
 *
 * The kernel writes anchors as prose (`{label, aliases}`) because that is all a
 * language model can know. The numbers come from the frame. Without this step
 * the play-time rules — walk closer, turn to face, the beacon — have nothing to
 * gate on and every chip is armed from across the room, which looks like the
 * rules are working right up until you notice they never say no.
 *
 * Best-effort by design: a failure here costs the geometry, not the world.
 * Returns how many anchors were stamped.
 */
async function groundAnchorGeometry(
  store: WorldStore,
  tools: ToolRunner | undefined,
  worldId: string,
  world: SMWorld,
  verified: VerifiedObject[],
): Promise<number> {
  if (verified.length === 0) return 0
  const byNoun = new Map<string, VerifiedObject>()
  for (const v of verified) {
    byNoun.set(v.label.toLowerCase(), v)
    for (const a of v.aliases) byNoun.set(a.toLowerCase(), v)
  }
  const ops: PublicOp[] = []
  for (const event of world.scene?.events ?? []) {
    const label = event.anchor?.label?.trim()
    if (!label) continue
    const v = byNoun.get(label.toLowerCase())
    if (!v) continue
    const anchor: SMEventAnchor = {
      label,
      // The detector's own vocabulary for this object beats the model's guess:
      // every one of these was PROBED and hit.
      aliases: [v.label, ...v.aliases].filter((a) => a.toLowerCase() !== label.toLowerCase()),
      ...(v.minProximity !== undefined ? { minProximity: v.minProximity } : {}),
      ...(v.expectedAspect ? { expectedAspect: v.expectedAspect } : {}),
    }
    // `patch`, not `event` — see lintHelp.autoFixOps: the store drops an
    // `event` key here, so the wrong shape writes nothing and reports success.
    ops.push({ op: 'update_event', name: event.name, patch: { anchor } })
  }
  if (ops.length === 0) return 0
  const res = await applyBatch(store, tools, worldId, ops)
  return res.ok ? ops.length : 0
}

/**
 * Every authored anchor must name something the detector actually found.
 *
 * The grounding block ASKS for this; asking is not enforcement. Watched live,
 * a model handed "coral reef (also: reef)" authored an anchor on "brain coral"
 * — a noun that had been probed and MISSED — which is precisely the
 * undetectable action the whole probe exists to prevent: at play time the
 * detector never finds it and the player can never click it. So it is checked,
 * and a violation goes back to the model as its own correction round, the same
 * way a doctrine error does.
 */
function ungroundedAnchors(world: SMWorld, verified: VerifiedObject[]): string[] {
  if (verified.length === 0) return []
  const allowed = new Set<string>()
  for (const v of verified) {
    allowed.add(v.label.toLowerCase())
    for (const a of v.aliases) allowed.add(a.toLowerCase())
  }
  const bad: string[] = []
  for (const event of world.scene?.events ?? []) {
    const label = event.anchor?.label
    if (typeof label === 'string' && label.trim() && !allowed.has(label.trim().toLowerCase())) {
      bad.push(`${event.name} anchors on "${label}"`)
    }
  }
  return bad
}

async function readWorld(store: WorldStore, worldId: string): Promise<SMWorld> {
  const [doc, scene] = await Promise.all([store.getWorld(worldId), store.getScene(worldId)])
  const base = doc.world ?? doc
  return { ...base, id: worldId, scene: { states: scene.states, events: scene.events } }
}


/**
 * REPAINT the opening frame of a world that already exists.
 *
 * Painting happened at CREATE and nowhere else, which meant the seed image was
 * always a picture of the premise — a sentence — while the entrance prose it
 * sits under went on being rewritten. An author who improved their opening had
 * no way to make the picture follow, and the seed is not decoration: it is the
 * frame the world model continues FROM, and the frame the anchor probe grounds
 * against.
 *
 * So this paints from the entrance state's OWN prose (its base plus its parked
 * camera), not from the premise. That is the whole difference between this and
 * `paintFirstFrame`: at create there is nothing but a premise, and afterwards
 * there is something better.
 *
 * Fail-closed and specific: with no image provider configured it says so rather
 * than quietly leaving the old frame in place, and a provider that refuses is
 * reported in its own words.
 */
export async function repaintEntrance(opts: {
  image: ImageProvider
  store: WorldStore
  tools: ToolRunner
  worldId: string
  signal?: AbortSignal | undefined
}): Promise<{ src: string; prompt: string }> {
  const { image, store, tools, worldId, signal } = opts
  if (!image.isConfigured()) {
    throw new GenerationError('No image model is configured — the opening frame is painted with YOUR key, in Settings.')
  }
  const [doc, scene] = await Promise.all([store.getWorld(worldId), store.getScene(worldId)])
  const world = unwrapWorldDoc(doc)
  const entranceId = world.entrance?.state ?? Object.keys(scene.states)[0]
  const entrance = entranceId ? scene.states[entranceId] : undefined
  if (!entranceId || !entrance) {
    throw new GenerationError('This world has no entrance state, so there is no opening frame to paint.')
  }

  const prompt = [entrance.base, entrance.camera?.static].filter(Boolean).join(' ')
  let painted: { b64: string; mime: string }
  try {
    painted = await image.generate(prompt, signal)
  } catch (e) {
    throw new GenerationError(`The image model refused: ${e instanceof Error ? e.message : String(e)}`)
  }

  const src = `data:${painted.mime};base64,${painted.b64}`
  const res = await tools.run(
    'author.entrance',
    { world: worldId, state: entranceId, image: src, label: 'the first frame' },
    { origin: 'app' },
  )
  if (!res.ok) throw new GenerationError(res.error.message)
  return { src, prompt }
}
