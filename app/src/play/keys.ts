/**
 * The driving controls, by PHYSICAL key.
 *
 * `KeyboardEvent.key` is the character a layout produces; `KeyboardEvent.code`
 * is the key's position on the board. Driving is a position question — the
 * three keys left-down-right of W are the same three keys whatever they print —
 * so an AZERTY player pressing ZQSD and a QWERTY player pressing WASD send the
 * identical codes and neither needs a second table. Keyed on `key`, a French
 * keyboard could not drive at all: the W position emits "z".
 *
 * Authored HOTKEYS stay on `key` on purpose, and that asymmetry is the point: an
 * author writes a letter, and the player should press whatever key makes that
 * letter. Position and character are different questions.
 *
 * Exported so the player and the on-screen keycaps read one table. They
 * disagreed the moment there were two, which is the whole reason this file
 * exists rather than a second copy in the HUD.
 */

export const MOVE_KEYS: Record<string, string> = {
  KeyW: 'Front', KeyS: 'Back', KeyA: 'Left', KeyD: 'Right',
}

export const LOOK_KEYS: Record<string, string> = {
  ArrowLeft: 'look_left', ArrowRight: 'look_right',
  ArrowUp: 'look_up', ArrowDown: 'look_down',
}

export const DRIVE_KEYS: Record<string, string> = {
  ...MOVE_KEYS, ...LOOK_KEYS,
  // Space/Shift REMOVED: they arrived here as 'Up'/'Down', which the Reactor
  // translator resolves into CAMERA PITCH (look_vertical), not movement — a
  // player pressing shift got an uncontrollable tilt. Vertical movement is not
  // in any walkable model's vocabulary, so the honest keycap is no keycap.
}

/**
 * What each key should PRINT on screen, which is a different question again.
 *
 * A cap is labelled for the board in front of the player: on AZERTY the W
 * position is engraved Z, so showing "W" there would be telling them to press a
 * key that is somewhere else. `KeyboardLayoutMap` answers this properly where
 * the browser supports it; `capFor` falls back to the QWERTY engraving, which is
 * right for most boards and never wrong about POSITION — the cap lights up
 * under the key they actually pressed either way.
 */
export const CAP_FALLBACK: Record<string, string> = {
  KeyW: 'W', KeyA: 'A', KeyS: 'S', KeyD: 'D',
  ArrowUp: '↑', ArrowDown: '↓', ArrowLeft: '←', ArrowRight: '→',
  Space: 'space', ShiftLeft: 'shift', ShiftRight: 'shift',
}

/** What to send when a key is RELEASED: these commands are persistent on the
 *  model side, so a released key must explicitly idle its own axis. */
export const AXIS_STOP_TOKEN: Record<string, string> = {
  KeyW: 'stop_move_longitudinal', KeyS: 'stop_move_longitudinal',
  KeyA: 'stop_move_lateral', KeyD: 'stop_move_lateral',
  ArrowLeft: 'stop_look_horizontal', ArrowRight: 'stop_look_horizontal',
  ArrowUp: 'stop_look_vertical', ArrowDown: 'stop_look_vertical',
}

/** The rows the HUD draws, in reading order. */
export const KEYCAP_ROWS: readonly (readonly string[])[] = [
  ['KeyW'],
  ['KeyA', 'KeyS', 'KeyD'],
  ['ArrowLeft', 'ArrowUp', 'ArrowDown', 'ArrowRight'],
]

/**
 * The engraving on a key, from the browser's layout map when it has one.
 *
 * `navigator.keyboard.getLayoutMap()` is Chromium-only, so this takes the map as
 * an argument rather than reaching for it: a caller that has one passes it, a
 * caller that does not gets the fallback, and this stays a function of its
 * inputs instead of a function of the browser it happens to run in.
 */
export function capFor(code: string, layout?: ReadonlyMap<string, string> | undefined): string {
  const engraved = layout?.get(code)
  if (engraved && engraved.length <= 2) return engraved.toUpperCase()
  return CAP_FALLBACK[code] ?? code
}

/** What a held key is doing, for the label under the caps. */
export function driveLabel(held: ReadonlySet<string>): string | null {
  const moves = [...held].filter((c) => c in MOVE_KEYS).map((c) => MOVE_KEYS[c])
  const looks = [...held].filter((c) => c in LOOK_KEYS).length > 0
  if (moves.length === 0 && !looks) return null
  if (moves.length === 0) return 'looking'
  return looks ? `${moves.join(' + ').toLowerCase()}, looking` : moves.join(' + ').toLowerCase()
}
