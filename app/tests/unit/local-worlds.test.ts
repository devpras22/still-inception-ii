/**
 * The two worlds written FOR the local models actually compile, and are shaped
 * the way a drive-only model requires.
 *
 * Without this they are decoration. An example world nothing compiles is prose
 * in a `.ts` file: it rots the first time the eDSL or the doctrine moves, and it
 * rots silently, because the only reader is a person who already believed it
 * worked. `compile()` runs the whole doctrine and throws on any error, so
 * merely calling it is most of the test.
 *
 * The rest pins the property that makes these worlds honest rather than merely
 * valid: `examples/world-doom.py` and `examples/world-mira.mjs` both declare
 * `promptableEvents: false`, so no authored prose reaches the picture and every
 * landing has to be readable FROM THE PICTURE. A transition here with no
 * `landWhen` would be a transition waiting for a prompt that will never be
 * sent — it would sit there forever and look like a broken world model.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'

import { program as doom } from '../../examples/doom-arena.sc'
import { program as mira } from '../../examples/mira-pitch.sc'

const WORLDS = [
  { name: 'doom-arena', program: doom, id: 'doom_arena' },
  { name: 'mira-pitch', program: mira, id: 'mira_pitch' },
]

for (const { name, program, id } of WORLDS) {
  test(`${name} compiles under the full doctrine`, () => {
    const { world, warnings } = program.compile()
    assert.equal(world.id, id)
    // Warnings are allowed — they are advice, and the shipped starter world
    // carries one on purpose. Errors would have thrown above.
    for (const w of warnings) assert.equal(w.severity, 'warning')
  })

  test(`${name} lands every transition on PIXELS, never on a prompt`, () => {
    const { world } = program.compile()
    const transitions = world.scene.events.filter((e) => e.kind === 'transition')
    assert.ok(transitions.length >= 2, 'a drive-only world needs somewhere to drive to')
    for (const ev of transitions) {
      assert.ok(
        ev.landWhen,
        `${ev.name} has no landWhen: with promptableEvents false nothing would ever land it`,
      )
      const free = ev.landWhen?.minMotion !== undefined
        || ev.landWhen?.maxMotion !== undefined
        || ev.landWhen?.minLuminance !== undefined
        || ev.landWhen?.maxLuminance !== undefined
      assert.ok(
        free,
        `${ev.name} lands on a detected label, which needs a vision key — these worlds `
          + 'ship for the keyless local path and must land on free signals',
      )
    }
  })

  test(`${name} leaves the driving keys to the player`, () => {
    const { world } = program.compile()
    // The player's hands are on W/A/S/D, the arrows, space and shift. An
    // authored hotkey on one of those fires an event every time somebody tries
    // to move, which is indistinguishable from the world model going haywire.
    const DRIVE = new Set(['w', 'a', 's', 'd', ' ', 'arrowup', 'arrowdown', 'arrowleft', 'arrowright', 'shift'])
    for (const ev of world.scene.events) {
      if (!ev.hotkey) continue
      assert.ok(
        !DRIVE.has(ev.hotkey.toLowerCase()),
        `${ev.name} claims the drive key '${ev.hotkey}'`,
      )
    }
  })
}

test('the two worlds tune their motion thresholds separately', () => {
  // A car at speed moves far more of the frame per sample than a walking
  // camera. Copying one world's constant into the other is how a landing fires
  // on the first twitch of the wheel, so this pins that they DIFFER — the
  // comment saying so in mira-pitch.sc.ts is not self-enforcing.
  const move = (p: typeof doom): number | undefined =>
    p.compile().world.scene.events.find((e) => e.landWhen?.minMotion !== undefined)?.landWhen?.minMotion
  const d = move(doom)
  const m = move(mira)
  assert.ok(d !== undefined && m !== undefined, 'both worlds land something on motion')
  assert.ok(m > d, `the car world should need more motion than the walking one (${m} vs ${d})`)
})
