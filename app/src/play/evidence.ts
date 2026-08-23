import type { SMLandWhen } from '../world'

/**
 * Arrival evidence: has the picture become the place we said we were going?
 *
 * A world model has no geometry and no notion of "arrived". The only honest
 * way to answer the question is by watching the frame, so that is the rule
 * set here. Firing a transition and landing the destination on a TIMER is
 * what produces the failure known as the rollback: the destination prompt
 * lands while the pixels still show the source, the two contradict, and the
 * model resolves backward.
 *
 * Two of the three signals cost nothing. Mean luminance and frame-to-frame
 * motion are arithmetic over pixels the player has already captured for the
 * chip layer, so they are checked FIRST and a vision call only happens when a
 * label is the evidence.
 *
 * Everything here is pure, over an explicit sample, so the thresholds are
 * pinned by tests instead of by watching a stream and hoping.
 */

/** Defaults: one tick of evidence, and a fail-open ceiling so a missed label
 *  can never trap a player mid-event. */
export const EVIDENCE = { hits: 1, timeoutMs: 20_000 } as const

/**
 * What `motion` actually reads, measured rather than guessed.
 *
 * 59 consecutive ticks at the player's own 700ms cadence and 160x96 downsample,
 * against a live world model, on an IDLE stream nobody was driving
 * (`evidence/motion-probe.mjs`, 2026-08-03):
 *
 *   min 3.22 · p10 3.46 · median 3.93 · p90 5.17 · max 7.31
 *   maxMotion 2 → satisfied by 0/59 ticks
 *   maxMotion 4 → 33/59      (the value the kernel prompt gives as its example)
 *   maxMotion 6 → 55/59
 *   maxMotion 8 → 59/59
 *
 * So a live world model never truly stops: "at rest" is about 4, not 0. The
 * kernel's example of 4 is reachable roughly half the time at rest — but a gate
 * is evaluated while the scene is REGENERATING toward its destination, which is
 * the noisiest moment there is, and the one authored `maxMotion: 4` gate this
 * project has recorded timed out at 20s and landed unverified.
 *
 * Sample at the same cadence if you re-measure: 2.5s apart the same stream reads
 * a median of 11.2 and never once dips below 4, which is how a first pass at
 * this nearly produced the confident, wrong conclusion that 4 is impossible.
 *
 * DURING A TRANSITION is the distribution that actually matters, because that
 * is when the gate is judged — the scene is regenerating toward its
 * destination. Measured over the 20s gate window after two real beats
 * (`evidence/close-loop.mjs`, same cadence, same session):
 *
 *   walk_bank   n=27  median  4.72  min 3.61  ticks at or under 4:  7/27
 *   turn_winch  n=28  median 24.34  min 8.75  ticks at or under 4:  0/28
 *
 * Six times the idle median, and never once at rest. A stillness gate written
 * at the idle floor therefore cannot pass while the world is still drawing the
 * place it is taking you to: it burns the full timeout and lands unverified,
 * which is exactly what the one recorded `maxMotion: 4` gate did.
 */
export const MOTION_OBSERVED = {
  min: 3.22, median: 3.93, p90: 5.17, max: 7.31, atRestAbout: 4,
  /** Median while the scene regenerates toward a destination. */
  duringTransition: 24.34,
  /** Above every idle tick seen (max 7.31) and far below the transition median,
   *  so it still discriminates: it says "settled", not "stopped". */
  settledCeiling: 8,
} as const

/**
 * A gate in the author's own terms, for when it did not pass.
 *
 * "The arrival evidence never appeared within its timeout" is true of every gate
 * and actionable for none: it does not say whether the world was supposed to
 * show something, hold still, or start moving. An author reading it learns
 * nothing about the gate they wrote.
 */
export function describeGate(when: SMLandWhen): string {
  const parts: string[] = []
  if (when.label) parts.push(`the picture never showed "${when.label}"`)
  if (when.maxMotion !== undefined) parts.push(`the picture never came to rest (needed motion at or under ${when.maxMotion}; a live world model idles around ${MOTION_OBSERVED.atRestAbout})`)
  if (when.minMotion !== undefined) parts.push(`the picture never moved enough (needed motion over ${when.minMotion})`)
  return parts.join(', and ')
}

/** One tick's reading of the picture. */
export interface FrameSample {
  /** Mean luminance, 0..255. */
  luminance: number
  /** Mean absolute per-pixel luminance change since the previous sample, 0..255.
   *  Null on the first sample — there is nothing to compare against, and
   *  claiming zero motion would land a `maxMotion` gate on no evidence at all. */
  motion: number | null
  /** The largest extent (min(w,h)) the label was found at this tick, if a label
   *  was asked for and hit. */
  labelExtent?: number | undefined
}

/**
 * Mean luminance of an RGBA buffer, and the mean absolute difference against a
 * previous buffer of the same size.
 *
 * Rec. 601 luma, sampled every `step`-th pixel: at 4 (the default) this reads a
 * quarter of the frame, which is far more than enough for a threshold and keeps
 * a per-tick pass off the main thread's budget.
 */
export function measureFrame(
  rgba: Uint8ClampedArray,
  previous?: Uint8ClampedArray | undefined,
  step = 4,
): { luminance: number; motion: number | null; luma: Uint8ClampedArray } {
  const n = Math.floor(rgba.length / 4)
  const sampled = Math.ceil(n / step)
  const luma = new Uint8ClampedArray(sampled)
  let sum = 0
  let j = 0
  for (let i = 0; i < n; i += step) {
    const o = i * 4
    const y = 0.299 * (rgba[o] ?? 0) + 0.587 * (rgba[o + 1] ?? 0) + 0.114 * (rgba[o + 2] ?? 0)
    luma[j] = y
    sum += y
    j += 1
  }
  const luminance = sampled > 0 ? sum / sampled : 0

  let motion: number | null = null
  if (previous && previous.length === luma.length && luma.length > 0) {
    let diff = 0
    for (let i = 0; i < luma.length; i += 1) diff += Math.abs((luma[i] ?? 0) - (previous[i] ?? 0))
    motion = diff / luma.length
  }
  return { luminance, motion, luma }
}

/**
 * Does this tick count as evidence? ANY satisfied signal counts: when BOTH
 * are set, EITHER passing counts as a hit. A `landWhen` with no signals at
 * all never counts, which is what the `auto-needs-pixels` lint exists to
 * catch before a player ever meets it.
 */
export function evidenceMet(when: SMLandWhen, sample: FrameSample): boolean {
  if (when.minLuminance !== undefined && sample.luminance > when.minLuminance) return true
  if (when.maxLuminance !== undefined && sample.luminance < when.maxLuminance) return true
  if (when.minMotion !== undefined && sample.motion !== null && sample.motion > when.minMotion) return true
  if (when.maxMotion !== undefined && sample.motion !== null && sample.motion < when.maxMotion) return true
  if (when.label !== undefined && sample.labelExtent !== undefined) {
    return sample.labelExtent >= (when.minExtent ?? 0)
  }
  return false
}

/** Free signals only — the ones worth checking before spending a vision call. */
export function hasPixelEvidence(when: SMLandWhen): boolean {
  return (
    when.minLuminance !== undefined ||
    when.maxLuminance !== undefined ||
    when.minMotion !== undefined ||
    when.maxMotion !== undefined
  )
}

/**
 * A trigger zone completes during FREE ROAM — no press — so it is honored for
 * the free, unambiguous signals only. A label is neither: a road being visible
 * does not mean you are driving down it, and paying a vision call per tick for
 * every auto event in the world would be a bill nobody asked for.
 */
export function autoEligible(when: SMLandWhen): boolean {
  return when.auto === true && hasPixelEvidence(when)
}

/** How many ticks of evidence this gate wants, and how long before it gives up
 *  and lands anyway. */
export function gateBudget(when: SMLandWhen): { hits: number; timeoutMs: number } {
  return {
    hits: Math.max(1, when.hits ?? EVIDENCE.hits),
    timeoutMs: Math.max(1000, when.timeoutMs ?? EVIDENCE.timeoutMs),
  }
}
