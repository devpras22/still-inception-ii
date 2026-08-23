/**
 * Ambient transients — the world's small moving things.
 *
 * Every state the kernel authors carries two or three "ambient" details,
 * because the authoring prompt asks for them explicitly. Until now NOTHING read
 * them: they were in the schema, in the eDSL, counted on a chip
 * in the graph, folded into a prompt panel that claimed to show what the model
 * receives — and never sent anywhere. Authored by every run this project has
 * ever made, and inert in all of them.
 *
 * The arrangement: a single line from the state's pool rides the streamed
 * state prompt for a few seconds, at a loose cadence, and never while an
 * event is playing. It is texture — traffic going past, a bird, water
 * moving — not a beat, so it must not interrupt one and must not repeat
 * itself back to back.
 *
 * The decisions live here as values so they can be tested without timers: a
 * component that owns both the choosing and the scheduling can only be checked
 * by watching it, which is how a mechanic ends up unverified.
 */

/**
 * The cadence. `holdMs` is how long one line rides the prompt;
 * the gap between transients is drawn from [minWaitMs, maxWaitMs].
 */
export const AMBIENT = { holdMs: 7_000, minWaitMs: 8_000, maxWaitMs: 20_000 } as const

/**
 * Which line to show next, given which one showed last.
 *
 * Never the same line twice running: with a two-line pool a fair coin repeats
 * half the time, and a world that says "a gull calls" twice in a row reads as
 * broken rather than atmospheric. `roll` is the caller's random draw in [0,1),
 * passed in rather than taken, so this is a function of its inputs.
 */
export function nextAmbient(
  pool: readonly string[],
  lastIndex: number,
  roll: number,
): { index: number; line: string } | null {
  const lines = pool.filter((l) => l.trim())
  if (lines.length === 0) return null
  const clamped = Math.min(Math.max(roll, 0), 0.999999)
  let i = Math.floor(clamped * lines.length)
  if (lines.length > 1 && i === lastIndex) i = (i + 1) % lines.length
  return { index: i, line: lines[i] as string }
}

/** How long to wait before the next transient, from a draw in [0,1). */
export function ambientWait(roll: number): number {
  const clamped = Math.min(Math.max(roll, 0), 1)
  return AMBIENT.minWaitMs + clamped * (AMBIENT.maxWaitMs - AMBIENT.minWaitMs)
}

/**
 * The state prompt with a transient riding on it.
 *
 * Appended, never substituted: the ambient line is an addition to the scene the
 * author wrote, and a state whose base prose was replaced by "a gull calls"
 * would lose the place it describes.
 */
export function promptWithAmbient(base: string, line: string | null): string {
  const b = base.trim()
  const l = (line ?? '').trim()
  if (!l) return b
  return b ? `${b} ${l}` : l
}
