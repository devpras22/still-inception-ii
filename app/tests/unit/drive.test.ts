/**
 * An authored move pressing its own controls.
 *
 * The value being checked is the TRANSLATION, because that is where this can go
 * wrong silently: the schema speaks an authoring grammar ("forward",
 * "strafe_left") and the transport speaks command tokens ("Front", "Left"). A wrong token does not fail here — it throws at the far end, inside
 * a live session, which is the worst place to learn about it.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { approachDistance, autopilotTokens, centeringLook, driveTokens, hasDrive, tickOdometer, waypointHud, DRIVE_RELEASE } from '../../src/play/drive'
import { driveCommandsForTest } from '../../src/provider/world/reactor'
import { LocalWorldStore } from '../../src/world/store/local'
import { fileStore, defaultStorePath } from '../../src/world/store/file.node'

test('each axis maps to the token the transport already understands', () => {
  assert.deepEqual(driveTokens({ movement: 'forward' }), ['Front'])
  assert.deepEqual(driveTokens({ movement: 'strafe_left' }), ['Left'])
  assert.deepEqual(driveTokens({ lookHorizontal: 'right' }), ['look_right'])
  assert.deepEqual(driveTokens({ lookVertical: 'up' }), ['look_up'])
  assert.deepEqual(driveTokens({ movement: 'back', lookVertical: 'down' }), ['Back', 'look_down'])
  assert.deepEqual(driveTokens(undefined), [])
  assert.equal(hasDrive({}), false, 'an empty drive is not a drive')
  assert.equal(hasDrive({ movement: 'forward' }), true)
})

test('EVERY token this emits is one the transport accepts', () => {
  // The pin that matters. The two tables live in different domains and drifted
  // apart once before (the LOOK vocabulary, found only in a live session), so
  // every value the schema allows is walked through the real translator here.
  const all = [
    ...(['forward', 'back', 'strafe_left', 'strafe_right'] as const).map((movement) => ({ movement })),
    ...(['left', 'right'] as const).map((lookHorizontal) => ({ lookHorizontal })),
    ...(['up', 'down'] as const).map((lookVertical) => ({ lookVertical })),
  ]
  for (const drive of all) {
    for (const token of driveTokens(drive)) {
      const commands = driveCommandsForTest(token)
      assert.ok(commands.length > 0, `${token} produced no command`)
      assert.doesNotMatch(JSON.stringify(commands), /idle/, `${token} resolved to idle`)
    }
  }
  // …and the release clears every axis the transport offers. Movement is TWO
  // commands here (longitudinal and lateral), not one — a stop that cleared a
  // single `set_movement` would leave a strafe held forever, and the commands
  // are persistent until set back to idle.
  const stop = JSON.stringify(driveCommandsForTest(DRIVE_RELEASE))
  assert.match(stop, /set_move_longitudinal/)
  assert.match(stop, /set_move_lateral/)
  assert.match(stop, /set_look_horizontal/)
  assert.match(stop, /set_look_vertical/)
})

test('the store carries a drive and refuses a control the grammar does not have', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'studio-drive-'))
  try {
    const store = new LocalWorldStore(fileStore(defaultStorePath({ STUDIO_HOME: dir })))
    const created = await store.createWorld({ template: 'starter' }, 'k')
    const id = created.worldId ?? ''
    let rev = (await store.getScene(id)).rev

    await store.applyOps(id, [
      { op: 'update_event', name: 'walk_up_the_lane', patch: { drive: { movement: 'forward' }, drivePulseMs: 500 } },
    ], rev)
    let ev = (await store.getScene(id)).events.find((e) => e.name === 'walk_up_the_lane')
    assert.deepEqual(ev?.drive, { movement: 'forward' })
    assert.equal(ev?.drivePulseMs, 500)

    rev = (await store.getScene(id)).rev
    await assert.rejects(
      () => store.applyOps(id, [{ op: 'update_event', name: 'walk_up_the_lane', patch: { drive: { movement: 'moonwalk' } } }], rev),
      /"drive" must be/,
    )
    await assert.rejects(
      () => store.applyOps(id, [{ op: 'update_event', name: 'walk_up_the_lane', patch: { drive: { sprint: 'yes' } } }], rev),
      /"drive" must be/,
    )

    // …and null erases it rather than leaving a channel held forever.
    await store.applyOps(id, [{ op: 'update_event', name: 'walk_up_the_lane', patch: { drive: null } }], rev)
    ev = (await store.getScene(id)).events.find((e) => e.name === 'walk_up_the_lane')
    assert.equal(ev?.drive, undefined)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('the servo turns TOWARD the subject, and leaves a centred one alone', () => {
  // A sign error here is invisible in review and unmistakable in a session: the
  // camera calmly turns away from the thing it is meant to be watching, and
  // keeps turning. A box right of centre means the camera is pointing left of
  // the subject, so the correction is to look RIGHT.
  assert.equal(centeringLook({ xMin: 0.70, xMax: 0.95 }), 'look_right')
  assert.equal(centeringLook({ xMin: 0.05, xMax: 0.30 }), 'look_left')
  assert.equal(centeringLook({ xMin: 0.40, xMax: 0.60 }), null, 'dead centre needs nothing')
  assert.equal(centeringLook(null), null, 'a missed detection FAILS OPEN — the standing drive stands')

  // The deadband is what stops a servo hunting: a subject a few percent off is
  // centred enough, and correcting it produces a camera that never settles.
  assert.equal(centeringLook({ xMin: 0.52, xMax: 0.72 }), null, 'inside the band')
  assert.equal(centeringLook({ xMin: 0.52, xMax: 0.72 }, 0.05), 'look_right', 'and outside a tighter one')
})

test('a state autopilot speaks the same grammar as a move drive', () => {
  assert.deepEqual(autopilotTokens({ movement: 'strafe_left', lookHorizontal: 'right' }), ['Left', 'look_right'])
  assert.deepEqual(autopilotTokens(undefined), [])
  assert.deepEqual(autopilotTokens({}), [])
})

test('the ODOMETER integrates forward travel, and nothing else', () => {
  // "The world model has no geometry, so POSITION = ACCUMULATED TRAVEL." A
  // distance that ticked down while the player turned on the spot would be a
  // lie about a journey they did not make.
  assert.equal(tickOdometer(100, 1000, true, 14), 86)
  assert.equal(tickOdometer(100, 1000, false, 14), 100, 'not driving, not travelling')
  assert.equal(tickOdometer(100, 0, true, 14), 100, 'no time, no distance')
  assert.equal(tickOdometer(5, 1000, true, 14), 0, 'and it never goes past the destination')
  assert.equal(tickOdometer(100, 500, true), 93, 'the default cruise is 14 m/s')
})

test('the destination comes into view before the turn-in', () => {
  // The default: min(200, 35% of the trip). The point is that the place is
  // on the horizon while the player is still driving, rather than appearing at
  // the moment they arrive.
  assert.equal(approachDistance({ label: 'X', distanceM: 800 }), 200)
  assert.equal(approachDistance({ label: 'X', distanceM: 400 }), 140)
  assert.equal(approachDistance({ label: 'X', distanceM: 300, approachM: 90 }), 90)

  const far = waypointHud({ label: 'PORT GELLHORN', distanceM: 800 }, 500)
  assert.deepEqual(far, { label: 'PORT GELLHORN', text: '500 m', approaching: false })
  const near = waypointHud({ label: 'PORT GELLHORN', distanceM: 800 }, 150)
  assert.equal(near.approaching, true)
  assert.equal(waypointHud({ label: 'X', distanceM: 800 }, 0).text, 'arriving')
})
