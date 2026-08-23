/**
 * Driving is a question about POSITION, not about characters.
 *
 * Keyed on `KeyboardEvent.key`, an AZERTY board could not drive at all: the W
 * position emits "z" and the A position "q", so WASD did nothing and ZQSD is
 * not a second mapping to add — it is the same four physical keys. `code`
 * reports position, so one table serves every layout including Dvorak and
 * Colemak, each of which would need its own row in a character table.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { DRIVE_KEYS, MOVE_KEYS, capFor, driveLabel } from '../../src/play/keys'

test('every layout drives with one table, because the table is positions', () => {
  // What an AZERTY player presses (Z Q S D) and a QWERTY player presses
  // (W A S D) are the SAME codes — this is the whole fix in one assertion.
  assert.equal(DRIVE_KEYS['KeyW'], 'Front')
  assert.equal(DRIVE_KEYS['KeyA'], 'Left')
  assert.equal(DRIVE_KEYS['KeyS'], 'Back')
  assert.equal(DRIVE_KEYS['KeyD'], 'Right')

  // No character key survives anywhere in the table: a stray 'w' would work on
  // QWERTY and silently fail on every other board, which is how this shipped.
  for (const code of Object.keys(DRIVE_KEYS)) {
    assert.ok(/^(Key[A-Z]|Arrow(Up|Down|Left|Right))$/.test(code),
      `"${code}" is not a physical key code`)
  }

  // Space and Shift drove DOWN once — and collided with the look-vertical
  // channel, so crouching pitched the camera. Vertical look belongs to the
  // arrows alone; the safest place for Space and Shift is out of the table.
  assert.equal(DRIVE_KEYS['Space'], undefined)
  assert.equal(DRIVE_KEYS['ShiftLeft'], undefined)
  assert.equal(DRIVE_KEYS['ShiftRight'], undefined)
})

test('a cap is engraved for the board in front of the player', () => {
  // With the browser's layout map, the AZERTY player sees the letters actually
  // printed on their keys — telling them to press W would point at the wrong key.
  const azerty = new Map([['KeyW', 'z'], ['KeyA', 'q']])
  assert.equal(capFor('KeyW', azerty), 'Z')
  assert.equal(capFor('KeyA', azerty), 'Q')

  // Without one (non-Chromium), the fallback is the QWERTY engraving: possibly
  // the wrong letter, never the wrong POSITION, and the cap still lights under
  // whichever key was pressed.
  assert.equal(capFor('KeyW', undefined), 'W')
  assert.equal(capFor('ArrowLeft', undefined), '←')
  assert.equal(capFor('Space', undefined), 'space')

  // A layout map answering with something long (a dead key, an IME label) is
  // ignored rather than printed into a 22px cap.
  assert.equal(capFor('KeyW', new Map([['KeyW', 'combining acute']])), 'W')
})

test('the label says what the world is being told, not what was pressed', () => {
  assert.equal(driveLabel(new Set()), null)
  assert.equal(driveLabel(new Set(['KeyW'])), 'front')
  assert.equal(driveLabel(new Set(['KeyW', 'KeyA'])), 'front + left')
  assert.equal(driveLabel(new Set(['ArrowLeft'])), 'looking')
  assert.equal(driveLabel(new Set(['KeyW', 'ArrowLeft'])), 'front, looking')
  // A key with no drive meaning contributes nothing — the label is about the
  // transport, so a lit cap with an empty label means a refused control.
  assert.equal(driveLabel(new Set(['KeyQ'])), null)
  assert.equal(Object.keys(MOVE_KEYS).length, 4)
})
