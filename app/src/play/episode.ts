/**
 * EPISODES — what actually happened during a session, and whether the evidence
 * an author wrote would have fired.
 *
 * A harness that scripts a run against the live model, records raw
 * observations, and reduces them with graders that are pure, deterministic,
 * and unit-testable is the reason the eDSL's `matches()` can recognise
 * evidence OFFLINE with no model and no GPU.
 *
 * Here, nothing scripts a run; a person plays. So the record is written by
 * the PLAYER as you play — the frames it already samples for arrival evidence,
 * the detect calls it already makes for chips, and a mark whenever a beat fires
 * or a state lands. Same record shape, different producer.
 *
 * Which makes the recogniser worth having: an author can ask, of a session that
 * already happened, "would this trigger zone have fired, and when?" — without
 * spending a frame of GPU to find out. That question is why FRAMES (cheap,
 * ~3 Hz, pixels) are kept separate from DETECTS (budgeted, a vision call):
 * they arrive at different rates and cost different money, and a record that
 * flattened them could not answer "which clause fired" honestly.
 *
 * The clause semantics: a spec's enabled clauses OR, pixel clauses evaluate
 * on frames, and the label clause on detects.
 */
import type { SMLandWhen } from '../world'

/** Cheap pixel sample: canvas-on-video, no network. */
export interface EpisodeFrame {
  /** ms since the episode started. */
  tMs: number
  /** Mean luminance 0-255. */
  lum: number
  /** Mean absolute change since the previous sample; null for the first, where
   *  claiming zero motion would land a `maxMotion` gate on no evidence. */
  motion: number | null
}

/** One detect call: every box found for one label. */
export interface EpisodeDetect {
  tMs: number
  label: string
  /** min(w, h) per box — the extent a `minExtent` clause is measured against. */
  extents: number[]
  /** Call latency, ms, when the caller measured it. */
  ms?: number | undefined
}

/** Something the player did or reached — `beat:enter_arch`, `state:atrium`. */
export interface EpisodeMark {
  tMs: number
  name: string
}

export interface EpisodeRecord {
  worldId: string
  startedAt: string
  frames: EpisodeFrame[]
  detects: EpisodeDetect[]
  marks: EpisodeMark[]
}

/** The clause set, mirroring the kernel's `landWhen`. OR semantics. */
export interface EvidenceSpec {
  label?: string | undefined
  aliases?: string[] | undefined
  /** Min box extent (min(w,h), 0-1) for the label clause. Default 0. */
  minExtent?: number | undefined
  minLuminance?: number | undefined
  maxLuminance?: number | undefined
  minMotion?: number | undefined
  maxMotion?: number | undefined
}

export function emptyRecord(worldId: string, startedAt: string): EpisodeRecord {
  return { worldId, startedAt, frames: [], detects: [], marks: [] }
}

/** The authored gate, as the clause set a record is replayed against. The
 *  budget fields (`hits`, `timeoutMs`, `auto`) are deliberately NOT here: they
 *  are how a LIVE gate is spent, not what counts as evidence. */
export function specFromLandWhen(when: SMLandWhen): EvidenceSpec {
  const spec: EvidenceSpec = {}
  if (when.label != null) spec.label = when.label
  if (when.aliases != null) spec.aliases = [...when.aliases]
  if (when.minExtent != null) spec.minExtent = when.minExtent
  if (when.minLuminance != null) spec.minLuminance = when.minLuminance
  if (when.maxLuminance != null) spec.maxLuminance = when.maxLuminance
  if (when.minMotion != null) spec.minMotion = when.minMotion
  if (when.maxMotion != null) spec.maxMotion = when.maxMotion
  return spec
}

function labelSet(spec: EvidenceSpec): Set<string> {
  const set = new Set<string>()
  if (spec.label) set.add(spec.label)
  for (const a of spec.aliases ?? []) set.add(a)
  return set
}

/** Pixel-clause pass for one frame. OR across the enabled clauses. */
export function framePasses(spec: EvidenceSpec, f: EpisodeFrame): boolean {
  if (spec.minLuminance != null && f.lum >= spec.minLuminance) return true
  if (spec.maxLuminance != null && f.lum <= spec.maxLuminance) return true
  if (f.motion != null) {
    if (spec.minMotion != null && f.motion >= spec.minMotion) return true
    if (spec.maxMotion != null && f.motion <= spec.maxMotion) return true
  }
  return false
}

/** Label-clause pass for one detect. */
export function detectPasses(spec: EvidenceSpec, d: EpisodeDetect): boolean {
  if (!spec.label) return false
  if (!labelSet(spec).has(d.label)) return false
  const floor = spec.minExtent ?? 0
  return d.extents.some((e) => e >= floor)
}

/** Time-ordered hit times for a spec, from `fromMs` onward. */
export function hitEvents(rec: EpisodeRecord, spec: EvidenceSpec, fromMs = 0): number[] {
  const events: number[] = []
  for (const f of rec.frames) if (f.tMs >= fromMs && framePasses(spec, f)) events.push(f.tMs)
  for (const d of rec.detects) if (d.tMs >= fromMs && detectPasses(spec, d)) events.push(d.tMs)
  events.sort((a, b) => a - b)
  return events
}

/** When a mark happened, or null. */
export function markTime(rec: EpisodeRecord, name: string): number | null {
  return rec.marks.find((m) => m.name === name)?.tMs ?? null
}

/**
 * Would this gate have fired during that session, and when?
 *
 * `hits` is read off the gate itself, so the answer means the same thing the
 * live player means by it: a gate needing three passing ticks is not satisfied
 * by one. A gate with no clauses at all can never fire and says so rather than
 * quietly passing on an empty spec.
 */
export function replayGate(
  when: SMLandWhen,
  rec: EpisodeRecord,
  fromMs = 0,
): { hits: number[]; passed: boolean; firedAtMs: number | null; groundable: boolean } {
  const spec = specFromLandWhen(when)
  const groundable = Object.keys(spec).length > 0
  const hits = groundable ? hitEvents(rec, spec, fromMs) : []
  const required = when.hits ?? 1
  const passed = hits.length >= required
  return { hits, passed, firedAtMs: passed ? hits[required - 1] ?? null : null, groundable }
}

/**
 * What a beat SENDS — and, by construction, what it does not.
 *
 * Its own function because the claim "narration never reaches the model" is
 * otherwise untestable: an end-to-end test can see what the runtime DREW, and
 * a mock that wraps its prompt to three lines cannot tell "this text was not
 * sent" from "this text was sent and clipped". A vacuous assertion is worse
 * than none, so the claim lives here, where it is a value.
 *
 * The event's own camera and movement DO ride along — they are instructions to
 * the model about this move. Narration is the one field a person reads.
 */
export function promptForBeat(beat: {
  text: string
  camera?: string | undefined
  movement?: string | undefined
  narration?: string | undefined
}): string {
  return [beat.text, beat.camera, beat.movement].filter(Boolean).join(' ')
}

/**
 * How long a session's picture stays trustworthy, measured rather than assumed.
 *
 * A live world model does not hold its style forever: over a single session the
 * frame drifts toward saturated, painterly garbage. Measured on lingbot-world-2
 * over Reactor with NOT ONE beat fired — the world opened and left completely
 * alone for five minutes (`evidence/drift-idle.mjs`, 2026-08-03), sampling mean
 * HSV saturation and the fraction of strongly-saturated pixels:
 *
 *   first 4 samples (0-36s,   ~0-50 frames)   meanSat 0.316  hot 0.122
 *   last  4 samples (264-300s, ~380-430)      meanSat 0.360  hot 0.212
 *
 * The saturated fraction nearly doubles, and by ~400 frames the edges of the
 * picture carry electric blue slabs while the subject is still recognisable.
 *
 * BUT THE NUMBERS VARY BY SESSION, and a second run says so plainly: a fresh
 * session of the SAME world read hot 0.209 at ~100 frames, and a long one read
 * 0.236 at ~100 and 0.242 at ~420 — a drift of 0.006, where the run above moved
 * 0.09 over the same span. So the SHAPE (a session's picture decays with frames,
 * with no input) is what these constants record; the magnitude is not reliable
 * to two digits and a threshold tuned finely against them would be fitting
 * noise. `visibleByFrames` is deliberately round for that reason.
 *
 * This REFUTES the tidy explanation. A recording had shown collapse after beats
 * fired on a 7s timer, and the conclusion was "pace the beats" — but pacing them
 * 26s apart did not prevent it, and here it happens with no input at all. Frames
 * alone degrade the picture. Beats and a session's position in a long run appear
 * to ACCELERATE it: an act reached fifth in one run was unusable by 137 frames,
 * where this untouched first session was still legible at 400.
 */
export const SESSION_DRIFT = {
  /** Saturated-pixel fraction on a fresh session. */
  freshHotFraction: 0.122,
  /** The same measure by ~400 frames, untouched. */
  driftedHotFraction: 0.212,
  /** Where degradation became visible with no input. Not a cliff — a slope. */
  visibleByFrames: 400,
} as const

/**
 * What to tell someone whose picture is drifting, or null while it is fine.
 *
 * The studio prints a frame count and nothing else, so a player watching the
 * world turn blue has no way to know that is the session ageing rather than
 * their world being badly authored. Re-seeding a fresh session at every act
 * boundary resets world-model drift — call it the chapter seam; the least
 * this can do is name it.
 */
export function driftNote(frames: number): string | null {
  if (frames < SESSION_DRIFT.visibleByFrames) return null
  return 'this session has run long enough that the picture drifts — start a fresh one to reset it'
}
