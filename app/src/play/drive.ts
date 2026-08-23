/**
 * An authored move pressing its own controls.
 *
 * The world model listens on two channels — the prompt and the movement/look
 * grammar — and the `SMDrive` type states what happens when they disagree: "a
 * take-off whose text says 'leaps and climbs' while the movement channel says
 * idle sends contradictory signals". A drive is how an authored beat makes
 * them agree without a player having to hold the right key while reading
 * prose about running.
 *
 * This module is the translation and nothing else, so it can be checked as a
 * value: the studio's command tokens are what the provider layer already
 * understands (`provider/world/reactor.ts`'s MOVEMENT / LOOK_HORIZONTAL /
 * LOOK_VERTICAL tables), and getting a token wrong there throws at the
 * transport — deliberately, since a beat addressing a control the model does
 * not have is a bug worth seeing.
 */
import type { SMDrive } from '../world'

const MOVEMENT_TOKEN: Record<NonNullable<SMDrive['movement']>, string> = {
  forward: 'Front',
  back: 'Back',
  strafe_left: 'Left',
  strafe_right: 'Right',
}
const LOOK_H_TOKEN: Record<NonNullable<SMDrive['lookHorizontal']>, string> = {
  left: 'look_left',
  right: 'look_right',
}
const LOOK_V_TOKEN: Record<NonNullable<SMDrive['lookVertical']>, string> = {
  up: 'look_up',
  down: 'look_down',
}

/** The tokens to send when this drive is applied, in axis order. */
export function driveTokens(drive: SMDrive | undefined): string[] {
  if (!drive) return []
  const out: string[] = []
  if (drive.movement) out.push(MOVEMENT_TOKEN[drive.movement])
  if (drive.lookHorizontal) out.push(LOOK_H_TOKEN[drive.lookHorizontal])
  if (drive.lookVertical) out.push(LOOK_V_TOKEN[drive.lookVertical])
  return out
}

/**
 * The token that RELEASES a drive.
 *
 * One token, not one per axis: the transport's stop clears all three at once,
 * which is the only release it offers. That has a cost worth naming — a player
 * holding a key while an authored drive ends is released too — and the
 * alternative (leaving a channel applied after its event) is worse: a held
 * `forward` that nothing clears walks the world away on its own.
 */
export const DRIVE_RELEASE = 'idle'

/** Does this drive say anything at all? An empty object is not a drive, and
 *  releasing on its behalf would stop a player who is holding a key. */
export function hasDrive(drive: SMDrive | undefined): boolean {
  return driveTokens(drive).length > 0
}

/**
 * THE VISUAL SERVO. Which way to look so a subject comes back to centre.
 *
 * A box whose centre sits right of frame centre means the camera is pointing
 * left of the subject, so the correction is to look RIGHT. The deadband is what
 * stops a servo hunting: a subject a few percent off centre is centred enough,
 * and correcting it would produce a camera that never settles.
 *
 * Its own function because a sign error here is invisible in review and obvious
 * in a session — the camera calmly turns away from the thing it is meant to be
 * watching, and keeps turning.
 */
export function centeringLook(
  box: { xMin: number; xMax: number } | null,
  deadband = 0.12,
): 'look_left' | 'look_right' | null {
  if (!box) return null
  const centre = (box.xMin + box.xMax) / 2
  const drift = centre - 0.5
  if (Math.abs(drift) <= deadband) return null
  return drift > 0 ? 'look_right' : 'look_left'
}

/** The tokens a state's standing autopilot holds. Same grammar as an event's
 *  drive — one is held for a move, the other for a room. */
export function autopilotTokens(autopilot: {
  movement?: SMDrive['movement']
  lookHorizontal?: SMDrive['lookHorizontal']
  lookVertical?: SMDrive['lookVertical']
} | undefined): string[] {
  return driveTokens(autopilot)
}

/**
 * THE ODOMETER. Where the player is, in a world with no geometry.
 *
 * The premise is plain: "the world model has no geometry, so POSITION =
 * ACCUMULATED TRAVEL" — and everything here follows from it.
 * Nothing can be asked where the destination is; what CAN be known is that the
 * player held forward for 1.4 seconds. Integrate that and you have a distance
 * which is real in the only sense the medium allows: they drove for it.
 *
 * Pure, so the arithmetic that decides when a mission ends can be checked
 * without a session.
 */
export interface WaypointSpec {
  label: string
  distanceM: number
  speedMs?: number | undefined
  approachM?: number | undefined
}

/** Cruise speed when the author did not say. */
export const WAYPOINT_SPEED_MS = 14

/** When the destination comes into view: `min(200, distance * 0.35)`. */
export function approachDistance(spec: WaypointSpec): number {
  return spec.approachM ?? Math.min(200, spec.distanceM * 0.35)
}

/**
 * Advance the odometer. Only forward travel counts — turning on the spot gets
 * you no closer to anywhere, and neither does reversing, which this grammar
 * treats as its own axis rather than as negative progress.
 */
export function tickOdometer(
  remainingM: number,
  dtMs: number,
  drivingForward: boolean,
  speedMs = WAYPOINT_SPEED_MS,
): number {
  if (!drivingForward || dtMs <= 0) return remainingM
  return Math.max(0, remainingM - (speedMs * dtMs) / 1000)
}

/** What the HUD says: the label, the distance, and whether the place is in
 *  sight yet. */
export function waypointHud(spec: WaypointSpec, remainingM: number): { label: string; text: string; approaching: boolean } {
  const approaching = remainingM <= approachDistance(spec)
  return {
    label: spec.label,
    text: remainingM <= 0 ? 'arriving' : `${Math.ceil(remainingM)} m`,
    approaching,
  }
}
