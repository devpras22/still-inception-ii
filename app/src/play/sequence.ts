/**
 * Walking a set-piece.
 *
 * A sequence is an ordered chain of states played as ONE unit, and the pacing
 * is the whole difference between a set-piece and four states in a row: the UFO
 * has to ARRIVE before the tank appears. The three dwells are three kinds of
 * waiting — hold until the picture stops moving, hand control back to the
 * player, or a plain timer — and picking the wrong one is what turns a
 * cinematic into a slideshow.
 *
 * The PLAN is a value so the walk can be checked without a session: what gets
 * entered, in what order, and how each beat ends.
 */
import type { SMSequence, SMSequenceBeat, SMLandWhen } from '../world'

export interface PlannedBeat {
  state: string
  /** How this beat ends. */
  dwell: 'settle' | 'input' | { ms: number }
  /** The evidence a `settle` beat waits on — the same motion gate a
   *  transition's `landWhen` uses, so one runtime path serves both. */
  gate?: SMLandWhen | undefined
}

/** A settling shot: the picture has come to rest — the signal that "the move
 *  has landed", and the reason `settle` is the default dwell.
 *
 *  MEASURED, AND THE MEASUREMENT REFUSED THE THRESHOLD (23 samples per
 *  condition on one scene, computed from the video independently of this
 *  code):
 *
 *      parked   min 5.80  p10 6.36   median 9.59   p90 11.48  max 12.63
 *      driving  min 10.19 p10 10.38  median 12.19  p90 13.93  max 14.77
 *
 *  The distributions OVERLAP. A parked shot reaches 12.63 while a driving one
 *  dips to 10.19, so no single motion number can mean "the shot came to rest" —
 *  a generated scene is never still. Water moves, fish cross, light shifts;
 *  rest is not the absence of change, which is the assumption a threshold
 *  borrowed from a rendered engine carries in with it.
 *
 *  12 is therefore INSIDE both distributions: it passes most parked frames and
 *  about half the driving ones, which is exactly the 1.7-second "settle" under
 *  a filmed strafe.
 *
 *  The constant is left where it is rather than moved to a number the data does
 *  not support. What the data DOES support is telling the author when a settle
 *  did not settle (below) — a gate that fails open silently teaches nothing,
 *  and this one fails open often. */
export const SETTLE_GATE: SMLandWhen = { maxMotion: 12, hits: 2, timeoutMs: 12_000 }

/**
 * A settle beat cannot be satisfied while no frames are arriving.
 *
 * A frozen picture measures as perfectly still, so "the scene settled" and "the
 * backend stopped sending" are the same number, and the one half of this the
 * player already knows about, because it runs a watchdog for exactly that
 * condition. A set-piece that walked its whole chain against a dead stream
 * would look, frame for frame, like one that played.
 */
export function settleSatisfiable(stalled: boolean): boolean {
  return !stalled
}

export class SequenceError extends Error {}

/**
 * Resolve a sequence into the beats a player will actually walk.
 *
 * Fail-closed on a beat naming a state that is not there: the store refuses to
 * WRITE one, but a world edited elsewhere (a deleted state, an imported file)
 * can still arrive here, and walking into a missing state mid-set-piece would
 * strand the player inside a cinematic.
 */
export function sequencePlan(sequence: SMSequence, states: Record<string, unknown>): PlannedBeat[] {
  if (sequence.beats.length === 0) {
    throw new SequenceError(`The set-piece "${sequence.title}" has no beats.`)
  }
  return sequence.beats.map((beat: SMSequenceBeat, i) => {
    if (!(beat.state in states)) {
      throw new SequenceError(
        `"${sequence.title}" beat ${i + 1} enters "${beat.state}", which this world no longer has.`,
      )
    }
    const dwell = beat.dwell ?? 'settle'
    return dwell === 'settle' ? { state: beat.state, dwell, gate: SETTLE_GATE } : { state: beat.state, dwell }
  })
}

/** The set-pieces a state can start. A sequence begins where its first beat is,
 *  so it is offered exactly where it makes sense to start one. */
export function sequencesFrom(sequences: readonly SMSequence[] | undefined, stateId: string | null): SMSequence[] {
  if (!sequences || !stateId) return []
  return sequences.filter((q) => q.beats[0]?.state === stateId)
}
