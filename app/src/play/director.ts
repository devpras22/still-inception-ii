/**
 * The DIRECTOR — typing an action while you are playing, and having the world
 * become it.
 *
 * This is the last authoring surface that was missing here, and the only one
 * that runs while the world is LIVE: everything else in `author/` edits a world
 * you are not currently standing in.
 *
 * THREE RULES CARRY THE WHOLE THING, each learned the hard way:
 *
 *  1. YES-AND, LITERALLY. Whatever the player typed happens exactly as typed —
 *     a dragon is a dragon, never sanitised into "a security drone". The brief
 *     says so explicitly, because a director that negotiates with the player's
 *     imagination is not a director.
 *
 *  2. FIT IT INTO THE STORY. There is no hard-coded arc here, so the brief is
 *     grounded in what the AUTHOR wrote: the state the player is standing in
 *     and the live objective off the world's own mission, read from data
 *     instead of a server constant.
 *
 *  3. NEVER TRUST THE MODEL TO TRIGGER. The agent authors the action but only
 *     unreliably emits the directive to PLAY it — a run that had just authored
 *     a cutscene came back with `directives=[]`, which is what this rule is
 *     built on rather than a hunch. So the SHAPE that was just authored is
 *     detected and played from here (`deterministicTrigger`).
 *     Without this the director appears to work and the picture never changes.
 *
 * And one refusal: the director may fire what it authored, but it may NEVER
 * auto-land an ending (`safeDirectives`). A bust is the player's.
 */
import type { SMEvent, SMMission, SMScene, SMWorld } from '../world'
import { missionProgress } from '../world'

/** A thing to PLAY, once something has been authored. Scoped to the fields
 *  that belong to surfaces this studio actually has. */
export interface Directive {
  /** Fire an authored event by name. */
  fire?: string | undefined
  /** Jump the machine to a state. */
  goto?: string | undefined
  /** Walk an authored set-piece by id. */
  playSequence?: string | undefined
  /** Wait this long before the next directive in the batch. */
  afterMs?: number | undefined
}

export interface DirectorContext {
  /** Where the player is standing. The brief's spatial anchor. */
  stateId: string
  /** Ids that exist, so the brief can say "branch off these, pick a new one". */
  stateIds: readonly string[]
  flags: ReadonlySet<string>
  /** The prose of the state the player is in — the density to match. */
  here?: string | undefined
  /** Subject / style locks, when the world carries them as data. */
  subject?: string | undefined
  styleTail?: string | undefined
  /** The live objective, read off the world's mission. */
  objective?: string | undefined
  /** What this world dramatically IS. */
  logline?: string | undefined
  /** What has already happened here, oldest first — the director's memory.
   *  Without it every typed action is answered from a blank slate: the graph
   *  says a state called `atrium_dragon` exists, and nothing says a dragon
   *  already came through the wall. */
  recentBeats?: string[] | undefined
}

export interface DirectorOutcome {
  ok: boolean
  /** The line the player reads back. */
  say: string
  /** Ops the kernel applied. 0 means nothing changed. */
  applied: number
  /** What to play, already filtered for safety. Empty is a legitimate result. */
  play: Directive[]
  /** Names of events that did not exist before this action. */
  authored: string[]
}

/** The live objective, as a sentence. The stage comes from the author's own
 *  mission data rather than a server-side constant. */
export function objectiveFor(missions: readonly SMMission[] | undefined, flags: ReadonlySet<string>): string | undefined {
  for (const m of missions ?? []) {
    const { activeIndex, complete } = missionProgress(m, flags)
    if (complete || activeIndex < 0) continue
    const step = m.objectives[activeIndex]
    if (step) return `${m.title} — right now: ${step.text}`
  }
  return undefined
}

/**
 * The authoring brief, from what the player typed.
 *
 * This is ALWAYS the deterministic brief, on purpose: the kernel that receives
 * it is itself a model perfectly able to do the fitting, and a director that
 * costs two round trips before the picture moves is a worse director. One
 * call, your own model.
 */
export function briefFor(text: string, ctx: DirectorContext): string {
  const slug = text.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 24) || 'act'
  const aftermath = `${ctx.stateId}_${slug}`
  const known = ctx.stateIds.slice(0, 48).join(', ') || '(none)'
  const held = [...ctx.flags].join(', ') || '(none yet)'
  return [
    `The player is standing in \`${ctx.stateId}\` and typed this, literally: "${text}".`,
    '',
    'YES-AND. Make EXACTLY that happen. Do not sanitise it, tone it down, or reinterpret it into',
    'something more plausible — a dragon is a real dragon, never a security drone. Lean in, however absurd.',
    '',
    'THEN FIT IT INTO THE STORY, which is the actual job. Give what they typed a ROLE in what the player',
    'is doing right now: it guards the thing they came for, or it opens the way they needed, or it hunts',
    'them. Never disconnected spectacle — it has to change their situation, toward the objective or against it.',
    ctx.logline ? `What this world is: ${ctx.logline}` : '',
    ctx.objective ? `The live objective: ${ctx.objective}` : 'The world declares no objective, so tie it to the place itself.',
    `Flags the player holds: ${held}`,
    // WHAT ALREADY HAPPENED. Kept so the director doesn't contradict or repeat
    // it — the difference between a story and a sequence of unrelated
    // surprises.
    ctx.recentBeats?.length
      ? `Already happened here, oldest first — do NOT repeat or contradict these:\n${ctx.recentBeats.map((b) => `  · ${b}`).join('\n')}`
      : '',
    '',
    'AUTHOR IT AS NEW STRUCTURE, AND IN THIS ORDER — every state must EXIST before an event points at it,',
    'so emit each add_state BEFORE the add_event whose "to" names it. An event that runs ahead of its',
    'destination is rejected, and the whole batch with it.',
    `- ONE transition event from \`${ctx.stateId}\`, named for the action, whose body PLAYS the moment`,
    '  happening (present tense). If it has several beats, give the event "phases" — 2 to 4 of them, each',
    '  with its own base and camera — so it animates instead of snapping.',
    `- It lands in a NEW aftermath state \`${aftermath}\`: the world right AFTER, at the full density of the`,
    '  prose already here, and NOT an ending.',
    `- From \`${aftermath}\`, add TWO visible transitions — the player\'s next two moves, both tied to the`,
    '  objective. Each carries its own body; a bare label streams nothing.',
    '',
    `NEVER edit \`${ctx.stateId}\` itself, never land an ending, and never touch an existing event.`,
    `Existing state ids (branch off these, and pick ids that do not collide): ${known}`,
    ctx.subject ? `Reuse this subject lock verbatim in every base you write: ${ctx.subject}` : '',
    ctx.styleTail ? `End every base with this style tail, verbatim: ${ctx.styleTail}` : '',
    ctx.here ? `\nThe prose to match, from \`${ctx.stateId}\`:\n${ctx.here}` : '',
  ]
    .filter((l) => l !== '')
    .join('\n')
}

/**
 * Directives the director is ALLOWED to run on its own.
 *
 * goto/fire only, NEVER one that LANDS an ending — the director can't
 * auto-bust; a bust is only ever the player's choice. A world where the story
 * can kill you without your hand on it is not a game.
 */
export function safeDirectives(
  scene: SMScene,
  ds: readonly Directive[],
  sequences: readonly { id: string; beats: readonly { state: string }[] }[] = [],
): Directive[] {
  const lands = (id?: string | undefined) => !!(id && scene.states[id]?.ending)
  return ds.filter((d) => {
    if (d.goto) return !!scene.states[d.goto] && !lands(d.goto)
    if (d.playSequence) {
      // The same refusal, applied to a chain: a set-piece that walks into an
      // ending would end the run without the player's hand on it.
      const seq = sequences.find((q) => q.id === d.playSequence)
      return !!seq && seq.beats.length > 0 && !seq.beats.some((b) => lands(b.state))
    }
    if (d.fire) {
      const ev = scene.events.find((e) => e.name === d.fire)
      return !!ev && !(ev.to !== undefined && lands(ev.to))
    }
    return false
  })
}

/**
 * What to play, read off the SHAPE that was just authored.
 *
 * The defect this exists for: the agent authors the action but only
 * unreliably emits a directive to play it, so the trigger is inferred here
 * instead. A fresh transition OUT OF the state the player is standing in is
 * the action itself; its reactions hang off the aftermath state, so
 * `from === stateId` picks the action and never a reaction. Falls back to any
 * fresh transition, then to the agent's OWN gotos, then to nothing.
 *
 * That third case is where a batch of more than one directive comes from, and
 * it was missing: the agent's goto-chain is kept when nothing fresh is
 * playable, because the pacing is a creative call that can't be inferred.
 * Without it, only a single directive could ever be produced, which is why the
 * player dropping everything after the first was invisible.
 */
export function deterministicTrigger(
  before: ReadonlySet<string>,
  after: readonly SMEvent[],
  stateId: string,
  sequences?: { beforeIds: ReadonlySet<string>; after: readonly { id: string }[] } | undefined,
  /** What the model itself asked for. Only its gotos are honoured here: a fire
   *  it names is checked against the graph by `safeDirectives`, and a goto is a
   *  camera move the graph cannot contradict. */
  asked?: readonly Directive[] | undefined,
): Directive[] | null {
  // A SET-PIECE FIRST. Sequences are checked ahead of events because a
  // set-piece may also add an entry transition, and firing the doorway would
  // run the first beat and abandon the other three.
  //
  // This branch was omitted while there were no sequences to trigger. There
  // are now.
  const newSeq = sequences?.after.find((q) => !sequences.beforeIds.has(q.id))
  if (newSeq) return [{ playSequence: newSeq.id }]

  const fresh = after.filter((e) => !before.has(e.name))
  const action =
    fresh.find((e) => e.to !== undefined && (Array.isArray(e.from) ? e.from : [e.from]).includes(stateId)) ??
    fresh.find((e) => e.to !== undefined)
  if (action) return [{ fire: action.name }]
  // NOTHING FRESH TO PLAY, but the model may have asked for a move anyway. Its
  // goto-chain is the one directive shape that cannot be wrong about the graph:
  // it names a state, and a state either exists or `safeDirectives` drops it.
  const gotos = (asked ?? []).filter((d) => d.goto)
  return gotos.length ? [...gotos] : null
}

/** Hold the channel long enough for a batch to perform. A fired event releases
 *  after about 6s on the player, so the hold has to outlast it; a goto is
 *  near-instant. */
export function batchHoldMs(items: readonly Directive[]): number {
  let ms = 1200
  for (const d of items) {
    ms += d.afterMs ?? 0
    if (d.fire) ms += 7000
    else if (d.playSequence) ms += 12_000
    else if (d.goto) ms += 800
  }
  return ms
}

/**
 * REWIND — the choice points behind you.
 *
 * A choice point is a state the player left by two or more legal doors, so
 * going back to it means something: the other door is still there. Rewinds to
 * the most recent one on the stack that is not where you are.
 */
export function isChoicePoint(scene: SMScene, stateId: string, flags: ReadonlySet<string>): boolean {
  const doors = scene.events.filter((e) => {
    const from = Array.isArray(e.from) ? e.from : e.from ? [e.from] : []
    return from.includes(stateId) && !e.hidden && (e.requires ?? []).every((f) => flags.has(f))
  })
  return doors.length >= 2
}

export function rewindTargetFor(choicePoints: readonly string[], stateId: string): string | null {
  for (let i = choicePoints.length - 1; i >= 0; i--) {
    const c = choicePoints[i]
    if (c !== undefined && c !== stateId) return c
  }
  return null
}

/** The kernel path this runs through — `runLocalEdit`, structurally. Taking it
 *  as a parameter keeps the director pure and testable without a model. */
export type Kernel = (instruction: string) => Promise<{
  reply: string
  applied: number
  /** What the model itself asked to happen. Only its gotos are used, and only
   *  when nothing fresh is playable — see `deterministicTrigger`. */
  asked?: { goto?: string; fire?: string; afterMs?: number }[] | undefined
}>

/**
 * How many times the director will hand a rejection back and ask again.
 *
 * This studio refuses partial batches rather than applying what it can and
 * collecting failures — a half-applied graph is worse than a refused edit —
 * which makes the correction round the thing that has to carry the tolerance.
 * Measured live: a real kernel put an `add_event` ahead of the `add_state` it
 * pointed at, the store rejected the batch, and the director had no second
 * try, so a typed action died on an ordering detail.
 *
 * Three: every round is a full round trip with a player standing in the world
 * waiting for it.
 */
const MAX_ROUNDS = 3

/** The rejection, phrased as the next instruction. The store's own message is
 *  quoted rather than summarised — it names the exact id that was missing. */
function correction(brief: string, why: string): string {
  return (
    `${brief}\n\nYOUR LAST ANSWER WAS REJECTED AND NOTHING WAS APPLIED: ${why}\n` +
    'Emit the WHOLE batch again, fixed. Every state must be added BEFORE any event that names it as "to", ' +
    'and every id you reference must be one you added in this same batch or one that already exists.'
  )
}

/**
 * One typed action, start to finish: brief → kernel → detect what was authored →
 * play it.
 *
 * FAIL-CLOSED like every other authoring path here. A kernel that changed
 * nothing plays nothing and says so; a kernel that threw is reported in the
 * director's own voice rather than leaked as a stack trace. `readScene` is
 * called twice on purpose — before, to know what existed, and after, to see what
 * the kernel actually wrote rather than what it claimed.
 */
export async function directAction(opts: {
  text: string
  ctx: DirectorContext
  kernel: Kernel
  readScene: () => Promise<SMScene>
  /** Told when a round was rejected, so the player sees it is still working
   *  rather than watching a silent gap. */
  onRound?: ((round: number, why: string) => void) | undefined
}): Promise<DirectorOutcome> {
  const text = opts.text.trim()
  if (!text) return { ok: false, say: '', applied: 0, play: [], authored: [] }

  const before = await opts.readScene()
  const known = new Set(before.events.map((e) => e.name))

  const brief = briefFor(text, opts.ctx)
  let reply = ''
  let asked: readonly Directive[] = []
  let applied = 0
  let lastError = ''
  for (let round = 1; round <= MAX_ROUNDS; round++) {
    try {
      const r = await opts.kernel(round === 1 ? brief : correction(brief, lastError))
      reply = r.reply
      asked = r.asked ?? []
      applied = r.applied
      lastError = ''
      break
    } catch (e) {
      lastError = e instanceof Error ? e.message : 'the model refused'
      opts.onRound?.(round, lastError)
    }
  }
  if (lastError) {
    return {
      ok: false,
      say: `could not stage that after ${MAX_ROUNDS} tries — ${lastError}`,
      applied: 0,
      play: [],
      authored: [],
    }
  }

  const after = await opts.readScene()
  const authored = after.events.filter((e) => !known.has(e.name)).map((e) => e.name)
  if (applied === 0 || authored.length === 0) {
    return { ok: false, say: reply || 'nothing was staged — try rephrasing', applied, play: [], authored }
  }

  // The model's own directives reach the trigger now. They were parsed nowhere
  // and passed nowhere, so `picked` could hold at most one inferred beat and a
  // goto-chain the model asked for was silently discarded.
  const picked = deterministicTrigger(known, after.events, opts.ctx.stateId, undefined, asked) ?? []
  return { ok: true, say: reply || 'staged', applied, play: safeDirectives(after, picked), authored }
}

/** The world's locks, for the brief. Kept here so the caller does not have to
 *  know which fields the schema carries them in. */
export function contextFrom(
  world: SMWorld,
  scene: SMScene,
  stateId: string,
  flags: ReadonlySet<string>,
): DirectorContext {
  // The last few beats, not all of them: a director that is handed an hour of
  // history spends its whole answer restating it, and the recent past is what
  // an improv actually has to stay consistent with.
  const beats = (world.story?.beats ?? []).slice(-RECENT_BEATS).map((b) => b.summary)
  return {
    stateId,
    stateIds: Object.keys(scene.states),
    flags,
    here: scene.states[stateId]?.base,
    subject: world.subject,
    styleTail: world.styleTail,
    objective: objectiveFor(world.missions, flags),
    logline: world.story?.logline,
    ...(beats.length ? { recentBeats: beats } : {}),
  }
}

/** How much of the past the director is told about. */
export const RECENT_BEATS = 6
