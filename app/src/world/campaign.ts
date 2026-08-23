/**
 * CAMPAIGNS — more than one world, joined into something with a spine.
 *
 * This exists for the book→game path: a manuscript becomes several acts, each
 * act is one world, and the macro-graph says how a player moves between them.
 *
 * SCOPE. That orchestration is four stages — read the prose, lay out the acts,
 * author each act, build the graph — and a hosted product runs them as four
 * server endpoints. Here they run in the browser against your own provider key
 * (`author/agent/book.ts`), so there is no server to deploy and no endpoint to
 * call. The engine below is pure and dependency-free: it is the part
 * that decides whether a multi-world story is playable at all. These lints
 * are the campaign-level analog of the per-act doctrine lints: they fail-close
 * on the structural ways an hours-long branching graph goes wrong.
 *
 * The four edge kinds are the whole vocabulary:
 *   golden      the protagonist's real choice — the book's true path
 *   deviation   a plausible wrong choice that continues, then comes back
 *   recombine   an off-book branch funnelling back onto the spine
 *   loop        a back-edge to an EARLIER act, carrying memory flags
 *
 * The load-bearing lint is `loop-terminates`. A loop that hands back no flag the
 * target act can gate a new exit on is an infinite loop: the player re-enters
 * the same act and leaves it the same way, forever. Nothing else here can catch
 * that, and a player finds it by living it.
 */
import type { SMWorld } from './api'

export type CampaignEdgeKind = 'golden' | 'deviation' | 'recombine' | 'loop'

/** A node in the macro-graph: one act = one world. */
export interface CampaignActRef {
  /** Stable key within the campaign (e.g. "act_1"). */
  actId: string
  /** The act's world id — must be a world this store can open. */
  worldId: string
  title: string
  /** On the faithful spine? */
  canonical: boolean
  /** Provenance back into the source, when there was one (e.g. "ch.3"). */
  chapterRef?: string | undefined
  summary?: string | undefined
}

/**
 * `from.state` is an EXIT state of the source act — a state the player reaches
 * that hands off to another act. `to === null` marks a dead end.
 */
/**
 * An edge in the macro-graph. `from.state` is an EXIT state of the source act —
 * a state the player reaches that hands off to another act.
 *
 * `to === null` marks a DEAD END: a terminal failure, from which the player
 * rewinds to the chapter checkpoint. It is a legal, authored outcome and not a
 * missing target — a live model wrote one ("The key is lost") and it read as a
 * bug here for exactly as long as this comment was missing.
 */
export interface CampaignEdge {
  from: { actId: string; state: string }
  to: { actId: string; entrance?: string | undefined } | null
  kind: CampaignEdgeKind
  /** Flags handed into the next act — the player's memory across worlds. */
  carryFlags?: string[] | undefined
  /** Only eligible while the player holds this flag. This is what lets a `loop`
   *  re-enter an act and leave it a DIFFERENT way the second time. */
  requiresFlag?: string | undefined
  label?: string | undefined
}

export interface CampaignGraph {
  start: string
  acts: CampaignActRef[]
  edges: CampaignEdge[]
  /** Ordered act ids: the faithful spine. */
  goldenThread: string[]
}

/** The campaign as it is stored: the macro-graph plus which world each act is. */
export interface Campaign {
  id: string
  title: string
  logline?: string | undefined
  graph: CampaignGraph
  created_at?: string | undefined
  updated_at?: string | undefined
}

export interface CampaignDiagnostic {
  severity: 'error' | 'warning' | 'info'
  rule: string
  message: string
  actId?: string | undefined
}

/** Index acts by id. */
export function actMap(graph: CampaignGraph): Map<string, CampaignActRef> {
  return new Map(graph.acts.map((a) => [a.actId, a]))
}

/** Every state in `actId` that hands off to another act. The runtime watches
 *  these to know when a chapter is over. */
export function exitStatesFor(graph: CampaignGraph, actId: string): Set<string> {
  const out = new Set<string>()
  for (const e of graph.edges) if (e.from.actId === actId) out.add(e.from.state)
  return out
}

/**
 * The macro-edge a player fires when act `actId` reaches `state`, given the
 * flags they hold. The selection order:
 *   1. only edges whose `requiresFlag` is satisfied (or absent) are eligible;
 *   2. prefer a `golden` edge — the faithful path is the default attractor;
 *   3. otherwise prefer a flag-GATED edge over an ungated one, so a memory loop
 *      takes its new exit on the second pass;
 *   4. otherwise the first eligible edge.
 * Null means the state is terminal: an ending, or a dead stop.
 */
export function resolveEdge(
  graph: CampaignGraph,
  actId: string,
  state: string,
  flags: ReadonlySet<string> | readonly string[] = [],
): CampaignEdge | null {
  const held = flags instanceof Set ? flags : new Set(flags)
  const eligible = graph.edges.filter(
    (e) => e.from.actId === actId && e.from.state === state && (!e.requiresFlag || held.has(e.requiresFlag)),
  )
  if (eligible.length === 0) return null
  const golden = eligible.find((e) => e.kind === 'golden')
  if (golden) return golden
  const gated = eligible.find((e) => !!e.requiresFlag)
  return gated ?? eligible[0] ?? null
}

/** The flags the next act boots with. Only what the edge explicitly hands
 *  forward — the author's memory budget — plus whatever the edge adds. */
export function carryFlagsThrough(edge: CampaignEdge, currentFlags: readonly string[]): string[] {
  const carried = edge.carryFlags ?? []
  const merged = currentFlags.filter((f) => carried.includes(f))
  for (const f of carried) if (!merged.includes(f)) merged.push(f)
  return merged
}

/** Acts reachable from `start` over any edge. */
export function reachableActs(graph: CampaignGraph): Set<string> {
  const seen = new Set<string>([graph.start])
  const queue = [graph.start]
  while (queue.length) {
    const cur = queue.shift()
    if (cur === undefined) continue
    for (const e of graph.edges) {
      if (e.from.actId !== cur) continue
      const next = e.to?.actId
      if (next && !seen.has(next)) {
        seen.add(next)
        queue.push(next)
      }
    }
  }
  return seen
}

/** Walk the golden thread from `start` and report whether it reaches an act
 *  that can actually be finished. */
export function goldenThreadReaches(
  graph: CampaignGraph,
  worlds: Record<string, SMWorld>,
): { ok: boolean; reason?: string } {
  let cur: string | undefined = graph.start
  const visited = new Set<string>()
  while (cur) {
    if (visited.has(cur)) return { ok: false, reason: `golden thread loops at "${cur}"` }
    visited.add(cur)
    const golden: CampaignEdge | undefined = graph.edges.find((e) => e.from.actId === cur && e.kind === 'golden')
    if (!golden) {
      // Terminal: this act has to offer a win, or the book cannot be completed.
      const world = worlds[cur]
      const hasWin = !!world && Object.values(world.scene?.states ?? {}).some((s) => s.ending?.kind === 'win')
      return hasWin ? { ok: true } : { ok: false, reason: `golden thread ends at "${cur}" with no win ending` }
    }
    if (!golden.to) return { ok: false, reason: `golden edge from "${cur}" is a dead-end` }
    cur = golden.to.actId
  }
  return { ok: false, reason: 'golden thread did not terminate' }
}

/**
 * Lint a campaign before it can be played. Errors fail closed.
 *
 *  - dangling-edge     every edge endpoint names a known act.
 *  - exit-state-exists every edge's `from.state` exists in its act's world.
 *  - act-has-world     every act ref resolves to a world.
 *  - unreachable-act   every act is reachable from `start`.
 *  - golden-thread     the spine runs start → win without gaps.
 *  - loop-terminates   every `loop` edge's target has a flag-gated exit whose
 *                      flag the loop carries, so the second pass can leave a
 *                      different way. Otherwise it is an infinite loop.
 */
export function lintCampaign(graph: CampaignGraph, worlds: Record<string, SMWorld>): CampaignDiagnostic[] {
  const diags: CampaignDiagnostic[] = []
  const ids = actMap(graph)

  if (!ids.has(graph.start)) {
    diags.push({ severity: 'error', rule: 'dangling-edge', message: `start act "${graph.start}" is not in acts[]` })
  }

  for (const e of graph.edges) {
    const tag = `${e.from.actId}:${e.from.state} → ${e.to?.actId ?? '∅'}`
    if (!ids.has(e.from.actId)) {
      diags.push({ severity: 'error', rule: 'dangling-edge', message: `edge from unknown act (${tag})`, actId: e.from.actId })
    }
    if (e.to && !ids.has(e.to.actId)) {
      diags.push({ severity: 'error', rule: 'dangling-edge', message: `edge to unknown act (${tag})`, actId: e.to.actId })
    }
    const world = worlds[e.from.actId]
    if (world && !world.scene?.states[e.from.state]) {
      diags.push({
        severity: 'error',
        rule: 'exit-state-exists',
        message: `exit state "${e.from.state}" not in act "${e.from.actId}" (${tag})`,
        actId: e.from.actId,
      })
    }
  }

  for (const a of graph.acts) {
    const world = worlds[a.actId]
    if (!world) {
      diags.push({ severity: 'error', rule: 'act-has-world', message: `act "${a.actId}" has no world`, actId: a.actId })
    } else if (world.id !== undefined && world.id !== a.worldId) {
      diags.push({
        severity: 'warning',
        rule: 'act-has-world',
        message: `act "${a.actId}" worldId "${a.worldId}" is not the world's own id "${world.id}"`,
        actId: a.actId,
      })
    }
  }

  const reach = reachableActs(graph)
  for (const a of graph.acts) {
    if (!reach.has(a.actId)) {
      diags.push({ severity: 'error', rule: 'unreachable-act', message: `act "${a.actId}" is unreachable from start`, actId: a.actId })
    }
  }

  const gt = goldenThreadReaches(graph, worlds)
  if (!gt.ok) diags.push({ severity: 'error', rule: 'golden-thread', message: gt.reason ?? 'golden thread is broken' })

  // THE LOAD-BEARING ONE.
  for (const loop of graph.edges.filter((e) => e.kind === 'loop')) {
    const target = loop.to?.actId
    if (!target) {
      diags.push({ severity: 'error', rule: 'loop-terminates', message: `loop edge from "${loop.from.actId}" has no target`, actId: loop.from.actId })
      continue
    }
    const carried = new Set(loop.carryFlags ?? [])
    const hasGatedExit = graph.edges.some((e) => e.from.actId === target && !!e.requiresFlag && carried.has(e.requiresFlag))
    if (!hasGatedExit) {
      diags.push({
        severity: 'error',
        rule: 'loop-terminates',
        message:
          `loop into "${target}" carries [${[...carried].join(', ') || '∅'}] but "${target}" has no flag-gated exit ` +
          'using a carried flag — the loop can never progress',
        actId: target,
      })
    }
  }

  return diags
}

/**
 * Has the BOOK finished?
 *
 * A state the macro-graph does not lead out of, whose ending is a win,
 * completes the campaign. Note it is not "the last act on the golden thread":
 * any terminal win ends the run, which is what lets a deviation be a real
 * alternative ending rather than a detour that must rejoin.
 *
 * This existed as a `dead-end` and nothing else: `handoffFor` learned to report
 * a terminal failure while its opposite went unnamed, so a player who reached
 * the end of the story was shown a state-level "YOU WIN" and never told the
 * campaign itself was over. Watched happening: act_3 rendered as "act 3 of 3"
 * with no notion of what finishing it would mean.
 */
export function campaignFinished(
  graph: CampaignGraph,
  actId: string,
  stateId: string,
  endingKind: string | undefined,
): boolean {
  if (endingKind !== 'win') return false
  return !graph.edges.some((e) => e.from.actId === actId && e.from.state === stateId)
}

export function campaignHasErrors(diags: readonly CampaignDiagnostic[]): boolean {
  return diags.some((d) => d.severity === 'error')
}

/** Where the player sits on the spine: index in `goldenThread`, or -1 off-book. */
export function goldenIndex(graph: CampaignGraph, actId: string): number {
  return graph.goldenThread.indexOf(actId)
}

/**
 * The hand-off, as one decision — the thing a player surface calls when a state
 * lands, so the rule lives here and not in a component.
 *
 * The entrance guard exists because a spine sometimes hangs a macro edge on
 * the entrance ("refuse to leave" / "leave next morning"), which would bounce
 * the player straight out of the chapter on boot — skipping it entirely. The
 * player must reach a real exit via a choice first.
 */
/**
 * What standing in a state means for the campaign: move on, or stop here.
 * `null` from `handoffFor` now means only "this state hands off nowhere".
 */
export type Handoff =
  | { kind: 'hop'; edge: CampaignEdge; toActId: string; entrance?: string | undefined; flags: string[] }
  | { kind: 'dead-end'; edge: CampaignEdge }

export function handoffFor(opts: {
  graph: CampaignGraph
  actId: string
  stateId: string
  entranceState?: string | undefined
  flags: readonly string[]
}): Handoff | null {
  if (opts.entranceState !== undefined && opts.stateId === opts.entranceState) return null
  const edge = resolveEdge(opts.graph, opts.actId, opts.stateId, opts.flags)
  if (!edge) return null
  // A dead end is an ANSWER, not the absence of one. Folding it into `null`
  // told every caller "nothing happens here", so the player stood in a state the
  // author had marked as a terminal failure and was never told. The rule is to
  // surface the dead-end so the player can rewind — never strand them; a caller
  // can only obey that if the two cases are distinguishable.
  if (!edge.to) return { kind: 'dead-end', edge }
  return {
    kind: 'hop',
    edge,
    toActId: edge.to.actId,
    entrance: edge.to.entrance,
    flags: carryFlagsThrough(edge, opts.flags),
  }
}
