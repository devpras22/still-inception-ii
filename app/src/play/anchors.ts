import type { DetectedBox } from '../provider'

/**
 * The rules that turn a stream of detector boxes into a chip you can actually
 * hit, tuned to match how a live player actually behaves.
 *
 * The studio already detected objects and drew a rectangle over each one. That
 * is not what makes the interaction work. A world model's picture DRIFTS —
 * pixel momentum keeps the camera wandering after you stop — and a detector
 * fires a few times a second on a moving frame, so a naive box strobes,
 * teleports, vanishes for a tick, and goes un-clickable under your finger at
 * the exact moment you commit to the tap. Every rule here exists because of one
 * of those failures:
 *
 *   · GLIDE, never teleport — EMA-smooth toward each detection.
 *   · HOLD STILL — a position deadband freezes the chip until the object has
 *     genuinely moved. The deadband widens once the chip is locked, so it
 *     barely stirs while you line up the click.
 *   · STAY PUT through a blink — a locked chip survives missed detections for
 *     ANCHOR_HOLD_MS instead of being yanked out from under a tap.
 *   · IN FRONT, not merely visible — the world model is DIRECTIONAL: an action
 *     resolves on whatever is centred, so firing on an off-axis object drifts
 *     or hallucinates. Off-axis chips say "turn to face" instead.
 *   · A GRACE WINDOW — once genuinely clickable, it stays clickable for
 *     ACTIONABLE_HOLD_MS, so a click you committed to while it was lined up
 *     still lands after movement lag drags it off centre.
 *   · A STEADY ARROW — the raw centre bounces across the middle between ticks,
 *     which strobes ◀▶; the direction latches and only flips when the object
 *     stays on the other side past a cooldown.
 *
 * Pure functions over an explicit `now`, so every one of those numbers is
 * pinned by a unit test instead of by watching a video and hoping.
 */

/** Empirically tuned constants — change them only after re-checking against
 *  real play, not by guessing. They were tuned against a detector ticking every
 *  350ms; the default vision path here is a public API and runs slower, so the
 *  unit tests prove these rules still fire on the numbers, NOT that the numbers
 *  are right for a slower cadence. If chips feel sluggish, suspect the cadence
 *  before editing anything below. */
export const ANCHOR = {
  /** EMA glide weight toward each new detection (lower = slower). */
  ema: 0.25,
  /** Position deadband before acquisition — the chip is still hunting. */
  deadbandFree: 0.035,
  /** …and once locked, so it barely moves while you aim at it. */
  deadbandLocked: 0.11,
  /** |cx − 0.5| at or under this = the object is IN FRONT of the camera. */
  aimTolerance: 0.2,
  /** The arrow only flips when the object is this far past centre… */
  turnFlipTolerance: 0.12,
  /** …and this long since the last flip. */
  turnFlipCooldownMs: 500,
  /** Consecutive misses that clear an UNACQUIRED anchor. */
  misses: 3,
  /** A locked anchor holds its last box this long after the last sighting. */
  anchorHoldMs: 2000,
  /** A chip stays clickable this long after it was last genuinely clickable. */
  actionableHoldMs: 2000,
} as const

/** One detection, as the chip layer needs it. */
export interface AnchorHit {
  /** Smoothed + deadbanded box — drives the chip's DISPLAY position (calm). */
  box: [number, number, number, number]
  /** Smoothed extent (display/secondary). */
  extent: number
  /** RAW extent — drives the RESPONSIVE proximity status, so the chip arms the
   *  moment you are close rather than when the smoothing catches up. */
  liveExtent: number
  /** RAW horizontal centre (0..1) — same reason, for the aim status. */
  liveCx: number
}

export interface AnchorTrack {
  hit: AnchorHit | null
  misses: number
  /** Last moment this anchor was genuinely detected. */
  lastSeen: number
  /** Has been close enough at least once during this state visit. Sticky: you
   *  walk up ONCE to arm it, and body-wander afterwards does not disarm it. */
  acquired: boolean
  /** Last moment it was genuinely clickable (centred AND close), or null if it
   *  never has been. A bare number defaulting through `?? 0` would make every
   *  chip on screen briefly clickable during the first two seconds after
   *  load, since 0 falls inside the grace window — null avoids that. */
  actionableAt: number | null
  /** Latched turn direction, with the moment it was latched. */
  turn: { dir: '◀' | '▶'; at: number } | null
}

export function emptyTrack(): AnchorTrack {
  return { hit: null, misses: 0, lastSeen: 0, acquired: false, actionableAt: null, turn: null }
}

/** min(width, height) of a normalised box — the proximity metric. A thin
 *  object read edge-on is FAR, however wide it sprawls across the frame. */
export function extentOf(b: DetectedBox): number {
  return Math.min(Math.max(0, b.xMax - b.xMin), Math.max(0, b.yMax - b.yMin))
}

/**
 * Fold one detection tick into a track. `detected` is null when the label was
 * not found in this frame; that is a MISS, not an error.
 */
export function observe(
  track: AnchorTrack,
  detected: DetectedBox | null,
  now: number,
  minProximity: number,
): AnchorTrack {
  if (!detected) {
    const misses = track.misses + 1
    // Hold a LOCKED box in place through a momentary detection drop, so the
    // chip does not vanish out from under a tap. Unacquired boxes clear at 3.
    const lockedHold = track.acquired && now - track.lastSeen < ANCHOR.anchorHoldMs
    if (misses >= ANCHOR.misses && !lockedHold) return { ...track, misses, hit: null }
    return { ...track, misses }
  }

  const db: [number, number, number, number] = [detected.xMin, detected.yMin, detected.xMax, detected.yMax]
  const liveExtent = extentOf(detected)
  const liveCx = (db[0] + db[2]) / 2
  const prev = track.hit

  // 1. GLIDE toward the detection. Snap on first acquisition (no prior).
  const a = ANCHOR.ema
  const ema: [number, number, number, number] = prev
    ? [
        prev.box[0] + a * (db[0] - prev.box[0]),
        prev.box[1] + a * (db[1] - prev.box[1]),
        prev.box[2] + a * (db[2] - prev.box[2]),
        prev.box[3] + a * (db[3] - prev.box[3]),
      ]
    : db

  // 2. HOLD STILL until the target's centre has genuinely shifted.
  let box = ema
  if (prev) {
    const deadband = track.acquired ? ANCHOR.deadbandLocked : ANCHOR.deadbandFree
    const dcx = (db[0] + db[2]) / 2 - (prev.box[0] + prev.box[2]) / 2
    const dcy = (db[1] + db[3]) / 2 - (prev.box[1] + prev.box[3]) / 2
    if (Math.hypot(dcx, dcy) < deadband) box = prev.box
  }

  const extent = prev ? prev.extent + a * (liveExtent - prev.extent) : liveExtent
  const acquired = track.acquired || liveExtent >= minProximity
  const centered = Math.abs(liveCx - 0.5) <= ANCHOR.aimTolerance
  const close = liveExtent >= minProximity || acquired

  // 3. LATCH the arrow — only flip when it is clearly on the other side and the
  //    cooldown has passed. Otherwise per-tick jitter strobes ◀▶.
  const wantDir: '◀' | '▶' = liveCx < 0.5 ? '◀' : '▶'
  let turn = track.turn
  if (!turn) turn = { dir: wantDir, at: now }
  else if (
    wantDir !== turn.dir &&
    Math.abs(liveCx - 0.5) > ANCHOR.turnFlipTolerance &&
    now - turn.at > ANCHOR.turnFlipCooldownMs
  ) {
    turn = { dir: wantDir, at: now }
  }

  return {
    hit: { box, extent, liveExtent, liveCx },
    misses: 0,
    lastSeen: now,
    acquired,
    actionableAt: centered && close ? now : track.actionableAt,
    turn,
  }
}

/**
 * Four looks, never a greyed dead control. Until it is interactable the chip is
 * an OBJECTIVE MARKER: a cyan ◆ beacon when it is straight ahead but too far,
 * an orange arrow when it is off to one side. Following either always leads to
 * a lock.
 */
export type ChipMode = 'sending' | 'armed' | 'beacon' | 'turn'

export function chipMode(track: AnchorTrack, now: number, minProximity: number, sending: boolean): ChipMode {
  if (sending) return 'sending'
  if (isActionable(track, now, minProximity)) return 'armed'
  const cx = track.hit?.liveCx ?? 0.5
  return Math.abs(cx - 0.5) <= ANCHOR.aimTolerance ? 'beacon' : 'turn'
}

/** Armed on PROXIMITY (sticky once acquired) AND CENTERING — plus the grace
 *  window after the last moment both held. */
export function isActionable(track: AnchorTrack, now: number, minProximity: number): boolean {
  const hit = track.hit
  const close = (!!hit && hit.liveExtent >= minProximity) || track.acquired
  const centered = Math.abs((hit?.liveCx ?? 0.5) - 0.5) <= ANCHOR.aimTolerance
  if (centered && close) return true
  return track.actionableAt !== null && now - track.actionableAt < ANCHOR.actionableHoldMs
}

/** What the chip says, per mode. */
export function chipLabel(mode: ChipMode, name: string, turn: '◀' | '▶'): string {
  if (mode === 'beacon') return '◆ get closer'
  if (mode === 'turn') return `${turn} turn to face`
  return name
}

/** Why the chip refused, in words a player can act on. */
export function chipRefusal(track: AnchorTrack, name: string): string {
  const centered = Math.abs((track.hit?.liveCx ?? 0.5) - 0.5) <= ANCHOR.aimTolerance
  return centered
    ? `Walk closer to ${name.charAt(0).toLowerCase()}${name.slice(1)}`
    : `Turn to face it — ${name}`
}

/**
 * Frame-space box centre → a percentage position over the MOUNT, honouring the
 * picture's object-fit. Without this the chip drifts off its object the moment
 * the video's aspect differs from its container: `cover` fills and crops
 * (scale = max), `contain` fits and letterboxes (scale = min), and the chip has
 * to track the picture, not the box it is drawn in.
 */
export function boxToPercent(
  box: [number, number, number, number],
  video: { w: number; h: number },
  view: { w: number; h: number },
  fit: 'cover' | 'contain',
): { leftPct: number; topPct: number } {
  if (video.w <= 0 || video.h <= 0 || view.w <= 0 || view.h <= 0) {
    return { leftPct: ((box[0] + box[2]) / 2) * 100, topPct: ((box[1] + box[3]) / 2) * 100 }
  }
  const scale =
    fit === 'cover'
      ? Math.max(view.w / video.w, view.h / video.h)
      : Math.min(view.w / video.w, view.h / video.h)
  const dw = video.w * scale
  const dh = video.h * scale
  const ox = (view.w - dw) / 2
  const oy = (view.h - dh) / 2
  return {
    leftPct: ((ox + ((box[0] + box[2]) / 2) * dw) / view.w) * 100,
    topPct: ((oy + ((box[1] + box[3]) / 2) * dh) / view.h) * 100,
  }
}


/**
 * Which beats the machine can legally take from where it stands.
 *
 * Three rules, not one: the state you are IN, the flags you HOLD, and whether a
 * one-shot has already been spent. The studio shipped only the first for a long
 * time, while `requires`/`grants`/`oneShot` were authored by the kernel, drawn
 * on the canvas and policed by a doctrine rule — a locked door that opened for
 * anyone. Pure, so the algebra is pinned by tests rather than by playing.
 */
export function legalBeats<T extends { name: string; from: string[]; requires?: string[] | undefined; oneShot?: boolean | undefined }>(
  beats: readonly T[],
  stateId: string | null,
  flags: ReadonlySet<string>,
  used: ReadonlySet<string>,
): T[] {
  return beats.filter((b) => {
    const here = b.from.length === 0 || (stateId !== null && b.from.includes(stateId))
    if (!here) return false
    if (b.oneShot && used.has(b.name)) return false
    return (b.requires ?? []).every((f) => flags.has(f))
  })
}


/**
 * Beats that are HERE and unspent but still gated — and that carry a reason.
 *
 * A locked action that simply vanishes reads as a world that is broken; one
 * that stays on screen, disabled, saying "Need: cut the power" reads as a world
 * with a lock in it. Only beats with a `lockedHint` qualify: an author who did
 * not write a reason meant it to stay hidden until it is available.
 */
export function lockedBeats<T extends { name: string; from: string[]; requires?: string[] | undefined; oneShot?: boolean | undefined; lockedHint?: string | undefined }>(
  beats: readonly T[],
  stateId: string | null,
  flags: ReadonlySet<string>,
  used: ReadonlySet<string>,
): T[] {
  return beats.filter((b) => {
    if (!b.lockedHint) return false
    const here = b.from.length === 0 || (stateId !== null && b.from.includes(stateId))
    if (!here) return false
    if (b.oneShot && used.has(b.name)) return false
    return !(b.requires ?? []).every((f) => flags.has(f))
  })
}

/**
 * What the beat bar says when it has no beats to offer.
 *
 * "Nothing leads out of this state — it is an ending" was shown whenever
 * `legalBeats` came back empty, and it comes back empty for two very different
 * reasons. With no `stateId` resolved yet — the window right after a campaign
 * hand-off swaps one act's world for another's — every beat is filtered out
 * because none of them are anchored to `null`, and the studio told the player
 * their story was over while it was still loading the next act. A recording
 * caught the bar empty at exactly that moment.
 *
 * An ending is a claim about the WORLD. Not knowing where you are is a claim
 * about the studio, and the two must not share a sentence.
 */
export function beatBarNote(stateId: string | null, availableCount: number): string | null {
  if (availableCount > 0) return null
  return stateId === null
    ? 'finding your place in the world…'
    : 'nothing leads out of this state — it is an ending.'
}
