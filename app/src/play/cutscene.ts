/**
 * Playing a clip on a seam.
 *
 * Two rules carry this:
 *
 *  1. RESOLUTION ORDER. The runtime resolves a transition's `to` against
 *     cutscene ids first, then state ids. A transition pointing at `C1` plays
 *     the cut and lands where the cut says; a transition pointing at a state
 *     goes straight there. Getting the order wrong makes a cutscene id that
 *     shadows a state silently unreachable — which is why the store refuses to
 *     write one that collides.
 *
 *  2. FAIL-OPEN. Missing or 404 means the runtime skips straight to the
 *     re-seed so the world is playable before final art lands. A world under
 *     construction has to stay playable, and a clip nobody has made yet must
 *     not become a wall. This is the rule most likely to be quietly lost in a
 *     port, because it only shows up when something is broken.
 */
import type { SMCutscene } from '../world'

/** How long to wait for a clip before deciding it is not coming. Generous
 *  enough for a real file on a slow connection AND for a narrated take to
 *  finish its voice-over — an 8s ceiling predates voiced clips and guillotined
 *  every memory mid-sentence while the file itself was fine. `ended`/`error`
 *  still resolve first; this is only the dead-URL backstop. */
export const CUTSCENE_TIMEOUT_MS = 30_000

/**
 * What a transition's `to` actually means: a cut to play, or a state to enter.
 * Cutscenes win, and a gated cut the player cannot satisfy is skipped rather
 * than blocking — its `to` is where they were going anyway.
 */
export function resolveDestination(
  to: string | undefined,
  cutscenes: readonly SMCutscene[] | undefined,
  flags: ReadonlySet<string>,
): { kind: 'cutscene'; cutscene: SMCutscene; state: string } | { kind: 'state'; state: string } | null {
  if (!to) return null
  const cut = (cutscenes ?? []).find((c) => c.id === to)
  if (!cut) return { kind: 'state', state: to }
  const gated = (cut.requires ?? []).some((f) => !flags.has(f))
  return gated ? { kind: 'state', state: cut.to } : { kind: 'cutscene', cutscene: cut, state: cut.to }
}

/** The cuts that leave a state — what an editor shows on the seam. */
export function cutscenesFrom(cutscenes: readonly SMCutscene[] | undefined, stateId: string | null): SMCutscene[] {
  if (!cutscenes || !stateId) return []
  return cutscenes.filter((c) => c.from === stateId)
}
