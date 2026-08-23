import type { SMWorld } from './api'

/**
 * The hard test: a deterministic verdict on whether an authored world is worth
 * playing, and if not, what to say to whoever authored it.
 *
 * This is a check that can FAIL generated content, and it is not a language
 * model grading its own homework. The doctrine (`./doctrine.ts`) answers a
 * different question — is anything in this world WRONG — and a world can
 * pass every lint while being unplayable, because nothing in an empty room
 * is incorrect.
 *
 * This was learned twice, on camera and a day apart: a run that authored a
 * name and one state reported success, and a run that authored six states
 * never wrote the one the player starts in. Both were caught by watching,
 * and both were then patched with a hand-rolled check. This replaces those
 * with one scored gate.
 *
 * WHAT IT ENFORCES is exactly what the kernel's own prompt promises — 5-8
 * states, 6-12 events, at least one real branch, a win AND a lose, everything
 * reachable, and an entrance that was actually written. Anything beyond that
 * (more decision points, flag-gated choices) is SCORED and reported, never
 * failed: a gate that fails work the prompt never asked for teaches authors to
 * ignore it.
 */

export interface WorldVerdict {
  /** Did it meet what the prompt promised? */
  pass: boolean
  /** 0..100. Advisory — `pass` is the gate, this is the quality signal. */
  score: number
  /** What to fix, phrased for whoever has to fix it. */
  issues: string[]
  stats: {
    states: number
    events: number
    branchPoints: number
    winStates: number
    loseStates: number
    gatedChoices: number
    unreachable: string[]
    danglingEnds: string[]
  }
}

export interface VerifyOpts {
  /** The premise, so an entrance still holding it can be recognised. */
  premise?: string | undefined
  /** Doctrine errors, counted by the caller (it already ran them). */
  lintErrors?: number | undefined
}

/** Every state reachable from `start` by following transitions. */
export function reachableFrom(start: string, world: SMWorld): Set<string> {
  const out = new Set<string>()
  const events = world.scene?.events ?? []
  const queue = [start]
  while (queue.length > 0) {
    const id = queue.shift()
    if (id === undefined || out.has(id)) continue
    out.add(id)
    for (const e of events) {
      if (e.kind === 'transition' && e.to && e.from.includes(id) && !out.has(e.to)) queue.push(e.to)
    }
  }
  return out
}

export function verifyWorld(world: SMWorld, opts: VerifyOpts = {}): WorldVerdict {
  const states = world.scene?.states ?? {}
  const events = world.scene?.events ?? []
  const ids = Object.keys(states)
  const issues: string[] = []
  let score = 0

  const nStates = ids.length
  const nEvents = events.length

  // DENSITY — the prompt asks for 5 to 8 states and 6 to 12 events.
  if (nStates >= 5) score += 20
  else {
    issues.push(`Only ${nStates} state${nStates === 1 ? '' : 's'} — the world needs 5 to 8 distinct places.`)
    if (nStates >= 3) score += 10
  }
  if (nEvents >= 6) score += 20
  else {
    issues.push(`Only ${nEvents} event${nEvents === 1 ? '' : 's'} — the world needs 6 to 12 things a player can do.`)
    if (nEvents >= 4) score += 10
  }

  // THE ENTRANCE — the first thing anyone sees, and what gets streamed first.
  const entranceId = world.entrance?.state ?? ids[0]
  const entrance = entranceId ? states[entranceId] : undefined
  const premise = (opts.premise ?? '').trim()
  const entranceStub =
    !!entrance &&
    (entrance.base.trim().length < 40 ||
      (premise !== '' && entrance.base.trim() === premise) ||
      entrance.base.trim() === 'Describe what the camera sees here.')
  if (!entrance) {
    issues.push('There is no entrance state — nothing would open.')
  } else if (entranceStub) {
    issues.push(
      `The entrance "${entranceId}" still holds the placeholder it was created with. It is the FIRST thing the ` +
        'player sees and the first prompt streamed to the model; write it at the density of every other state.',
    )
  } else {
    score += 10
  }

  // REAL BRANCHING: a state the player leaves by two DIFFERENT doors — not one
  // way forward plus one way to die.
  const targets = new Map<string, Set<string>>()
  for (const e of events) {
    if (e.kind !== 'transition' || !e.to) continue
    for (const from of e.from) {
      const set = targets.get(from) ?? new Set<string>()
      set.add(e.to)
      targets.set(from, set)
    }
  }
  const branchPoints = [...targets.values()].filter((s) => s.size >= 2).length
  if (branchPoints >= 3) score += 20
  else if (branchPoints >= 1) score += 12
  if (branchPoints === 0) {
    issues.push('No real decision point: every state leads one way. Add a place where the player chooses between two DIFFERENT continuations.')
  } else if (branchPoints < 2) {
    issues.push(`Only ${branchPoints} real decision point — a second one is what makes a world worth replaying.`)
  }

  // ENDINGS — the prompt asks for a win AND a lose, both reachable.
  const winStates = ids.filter((id) => states[id]?.ending?.kind === 'win')
  const loseStates = ids.filter((id) => states[id]?.ending?.kind === 'lose')
  if (winStates.length > 0) score += 8
  else issues.push('No win ending — the world cannot be completed.')
  if (loseStates.length > 0) score += 7
  else issues.push('No lose ending — nothing is at stake.')

  // REACHABILITY, and paths that simply STOP. A terminal state that is not an
  // ending is a corridor the player walks into and is left in.
  const reach = entranceId ? reachableFrom(entranceId, world) : new Set<string>()
  const unreachable = ids.filter((id) => !reach.has(id))
  if (unreachable.length === 0) score += 10
  else issues.push(`Unreachable from the entrance: ${unreachable.join(', ')} — wire an event into each, or delete them.`)

  const danglingEnds = ids.filter(
    (id) => reach.has(id) && !states[id]?.ending && !events.some((e) => e.kind === 'transition' && e.to && e.from.includes(id)),
  )
  if (danglingEnds.length === 0) score += 5
  else {
    issues.push(
      `${danglingEnds.length} state(s) lead nowhere and are not endings: ${danglingEnds.join(', ')}. ` +
        'A path must either continue or END — a state that just stops leaves the player standing in it.',
    )
  }

  // STATE-CHANGING CHOICES — scored, never failed: the prompt does not ask for
  // them, and a gate that fails unasked-for work teaches authors to ignore it.
  const gatedChoices = events.filter((e) => (e.requires?.length ?? 0) > 0 || (e.grants?.length ?? 0) > 0).length
  if (gatedChoices >= 3) score += 5
  else if (gatedChoices >= 1) score += 2
  else issues.push('Nothing a player does changes what is available later — consider grants/requires so an early choice opens or closes a later one.')

  if (opts.lintErrors && opts.lintErrors > 0) {
    issues.push(`${opts.lintErrors} doctrine error(s) — those block play on their own.`)
  }

  const pass =
    nStates >= 5 &&
    nEvents >= 6 &&
    branchPoints >= 1 &&
    winStates.length > 0 &&
    loseStates.length > 0 &&
    !!entrance &&
    !entranceStub &&
    unreachable.length === 0 &&
    danglingEnds.length === 0 &&
    (opts.lintErrors ?? 0) === 0

  return {
    pass,
    score: Math.min(100, score),
    issues,
    stats: {
      states: nStates,
      events: nEvents,
      branchPoints,
      winStates: winStates.length,
      loseStates: loseStates.length,
      gatedChoices,
      unreachable,
      danglingEnds,
    },
  }
}

/** The verdict as the sentence a kernel gets told, when it has to try again. */
export function critique(verdict: WorldVerdict): string {
  return (
    `That world does not pass the bar (${verdict.score}/100): ` +
    `${verdict.stats.states} states, ${verdict.stats.events} events, ` +
    `${verdict.stats.branchPoints} real branch${verdict.stats.branchPoints === 1 ? '' : 'es'}, ` +
    `${verdict.stats.winStates} win / ${verdict.stats.loseStates} lose.\n\n` +
    verdict.issues.map((i) => `- ${i}`).join('\n') +
    // NOT "emit the whole world again", which is what this said and which cost a
    // whole correction round every time it fired. By the time a verdict is
    // reached the ops have ALREADY been applied — that is the only way to have a
    // world to score — so re-emitting the graph re-emits `add_state` for states
    // that now exist, the store refuses the batch ("a state called X already
    // exists"), and the round is spent on a collision the instruction asked for.
    // Measured: one of two kernel failures in twenty ran exactly this way.
    '\n\nThe world above is ALREADY WRITTEN. Emit ops against it as it now stands — add what is ' +
    'missing and update what is weak. Do not re-add states or events that are already there.'
  )
}

/**
 * A/B: the same world with one state's prose replaced by one of its variants.
 *
 * The point is the seed: an author plays A and then B from the SAME entrance
 * image, so the only thing that differs between the two runs is the words.
 * Anything else — a fresh seed, a different starting state — and the
 * comparison is measuring the wrong thing.
 *
 * Returns the world unchanged when the label names no variant, because a
 * mistyped label must not silently play something else.
 */
export function worldWithVariant(world: SMWorld, stateId: string, label: string | null): SMWorld {
  const state = world.scene?.states?.[stateId]
  if (!state || label === null) return world
  const variant = (state.variants ?? []).find((v) => v.label === label)
  if (!variant) return world
  return {
    ...world,
    scene: {
      ...world.scene,
      states: {
        ...world.scene.states,
        [stateId]: {
          ...state,
          base: variant.base,
          ...(variant.camera ? { camera: variant.camera } : {}),
          ...(variant.movement ? { movement: variant.movement } : {}),
          ...(variant.ambient ? { ambient: variant.ambient } : {}),
          // The variant is what is PLAYING now; carrying the list into the
          // played copy would let a second swap compound onto the first.
          variants: undefined,
        },
      },
    },
  }
}
