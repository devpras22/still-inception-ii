/**
 * The clip at the start and the clip at the end.
 *
 * These are the two special cases of a cutscene, and they are separate fields
 * for good reasons that are worth keeping:
 *
 *  · THE INTRO HIDES A BOOT. The session starts (and the seed prompt lands)
 *    UNDERNEATH the video, so by the final frame the live stream is already
 *    running — author the entrance seed as the video's LAST FRAME and the cut
 *    is invisible. It is not a delay before the world; it is a cover over the
 *    part of the world that always looks bad.
 *
 *  · `introStatic` SAYS HOW THE CLIP ENDS. The intro video ends on a STILL
 *    subject… so the live session must boot on the STATIC movement layer — no
 *    moving=true init, no forward drive. Default (false) = the intro ends
 *    mid-motion and the boot CONTINUES it. A clip that ends mid-stride and a
 *    world that boots standing still is a visible cut; the flag is the author
 *    telling the runtime which one they shot.
 *
 *  · THE OUTRO IS EARNED, ONCE. It plays when `flag` is held while `state` is
 *    current, then the live world resumes for free roam — so it is a
 *    condition, not a destination, and firing it twice would replay a victory
 *    the player already had.
 */
export interface Outro {
  video: string
  flag: string
  state: string
}

/** Should the outro play right now? Once — the caller records that it has. */
export function outroDue(
  outro: Outro | undefined,
  stateId: string | null,
  flags: ReadonlySet<string>,
  alreadyPlayed: boolean,
): boolean {
  if (!outro || alreadyPlayed || !stateId) return false
  return stateId === outro.state && flags.has(outro.flag)
}

/**
 * How the live session should come out from under an intro.
 *
 * `moving` selects the DYNAMIC prose layers and, with a forward token, keeps the
 * camera travelling — which is what a clip ending mid-stride needs the world to
 * do. A still ending needs the opposite, and the default is to continue the
 * motion unless the author says the clip stops.
 */
export function bootAfterIntro(introStatic: boolean | undefined): { moving: boolean; driveToken: string | null } {
  return introStatic ? { moving: false, driveToken: null } : { moving: true, driveToken: 'Front' }
}
