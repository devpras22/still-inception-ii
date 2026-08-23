/**
 * The anchor chip rules, pinned by number.
 *
 * Every constant in `src/play/anchors.ts` was tuned against a drifting
 * world-model picture that no unit test can reproduce. What a test CAN do is
 * prove each rule still fires on the numbers it was tuned to — so a future
 * edit that "simplifies" the deadband or drops the grace window fails here
 * instead of on camera.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  ANCHOR,
  emptyTrack,
  extentOf,
  observe,
  isActionable,
  chipMode,
  chipLabel,
  chipRefusal,
  boxToPercent,
  legalBeats,
  beatBarNote,
} from '../../src/play/anchors.ts'
import { DEFAULT_PROXIMITY } from '../../src/world'

const box = (xMin: number, yMin: number, xMax: number, yMax: number) => ({ xMin, yMin, xMax, yMax })

test('extent is the SHORT side — a thin object read edge-on is far, however wide', () => {
  assert.equal(Math.round(extentOf(box(0.1, 0.4, 0.9, 0.5)) * 100) / 100, 0.1)
  assert.equal(Math.round(extentOf(box(0.3, 0.3, 0.6, 0.7)) * 100) / 100, 0.3)
})

test('first sighting SNAPS, later ones GLIDE by the EMA weight', () => {
  const t0 = observe(emptyTrack(), box(0.2, 0.2, 0.4, 0.4), 1000, 0)
  assert.deepEqual(t0.hit?.box, [0.2, 0.2, 0.4, 0.4], 'no prior to glide from — snap')

  // Move far enough to clear the deadband, then check it moved only a quarter
  // of the way (ema 0.25), not all the way.
  const t1 = observe(t0, box(0.6, 0.2, 0.8, 0.4), 1400, 0)
  assert.equal(Math.round((t1.hit?.box[0] ?? 0) * 1000) / 1000, 0.3)
  assert.equal(ANCHOR.ema, 0.25)
})

test('the position deadband FREEZES the chip when the object barely moved', () => {
  const t0 = observe(emptyTrack(), box(0.2, 0.2, 0.4, 0.4), 1000, 0)
  // A 0.02 nudge is under the free deadband (0.035) — the chip must not stir.
  const t1 = observe(t0, box(0.22, 0.2, 0.42, 0.4), 1200, 0)
  assert.deepEqual(t1.hit?.box, t0.hit?.box, 'held still')
  // …but the LIVE readings still update, so aim/proximity stay responsive.
  assert.equal(Math.round((t1.hit?.liveCx ?? 0) * 100) / 100, 0.32)
})

test('a LOCKED chip gets the wider deadband — it barely moves while you aim', () => {
  // minProximity 0.1: this box is 0.2 short-side, so it acquires at once.
  const t0 = observe(emptyTrack(), box(0.4, 0.4, 0.6, 0.6), 1000, 0.1)
  assert.equal(t0.acquired, true)
  // A 0.08 shift clears the FREE deadband but not the LOCKED one (0.11).
  const t1 = observe(t0, box(0.48, 0.4, 0.68, 0.6), 1200, 0.1)
  assert.deepEqual(t1.hit?.box, t0.hit?.box, 'locked chips hold still')
})

test('an unacquired anchor clears after 3 misses; a locked one holds for 2s', () => {
  const far = observe(emptyTrack(), box(0.45, 0.45, 0.5, 0.5), 1000, 0.9) // never close enough
  assert.equal(far.acquired, false)
  let t = far
  for (let i = 0; i < ANCHOR.misses; i++) t = observe(t, null, 1000 + i * 100, 0.9)
  assert.equal(t.hit, null, 'three misses and it is gone')

  const near = observe(emptyTrack(), box(0.4, 0.4, 0.6, 0.6), 1000, 0.1)
  let held = near
  for (let i = 0; i < 6; i++) held = observe(held, null, 1500 + i * 100, 0.1)
  assert.notEqual(held.hit, null, 'a locked chip survives a detection blink')
  const expired = observe(held, null, 1000 + ANCHOR.anchorHoldMs + 1, 0.1)
  assert.equal(expired.hit, null, '…but not past the hold window')
})

test('acquisition is STICKY for the visit: body-wander does not disarm it', () => {
  const close = observe(emptyTrack(), box(0.4, 0.4, 0.6, 0.6), 1000, 0.15)
  assert.equal(close.acquired, true)
  // Drifts away to a much smaller reading — still armed, because you already
  // walked up to it once.
  const drifted = observe(close, box(0.46, 0.46, 0.52, 0.52), 1400, 0.15)
  assert.equal(drifted.acquired, true)
  assert.equal(isActionable(drifted, 1400, 0.15), true)
})

test('off-axis is NOT actionable — the model resolves on what is centred', () => {
  const side = observe(emptyTrack(), box(0.02, 0.4, 0.22, 0.6), 1000, 0)
  assert.equal(Math.abs((side.hit?.liveCx ?? 0) - 0.5) > ANCHOR.aimTolerance, true)
  assert.equal(isActionable(side, 1000, 0), false)
  assert.equal(chipMode(side, 1000, 0, false), 'turn')
})

test('the 2s grace window keeps a committed click landing after drift', () => {
  const armed = observe(emptyTrack(), box(0.4, 0.4, 0.6, 0.6), 1000, 0.1)
  assert.equal(isActionable(armed, 1000, 0.1), true)
  // It slides off-axis. Still clickable inside the window…
  const drifted = { ...armed, hit: { ...armed.hit!, liveCx: 0.05 }, acquired: false }
  assert.equal(isActionable(drifted, 1000 + ANCHOR.actionableHoldMs - 50, 0.1), true)
  // …and not after it.
  assert.equal(isActionable(drifted, 1000 + ANCHOR.actionableHoldMs + 50, 0.1), false)
})

test('the turn arrow LATCHES — jitter across centre never strobes it', () => {
  let t = observe(emptyTrack(), box(0.0, 0.4, 0.2, 0.6), 1000, 0) // left
  assert.equal(t.turn?.dir, '◀')
  // Jitter just past centre, immediately: too soon AND too close to centre.
  t = observe(t, box(0.5, 0.4, 0.72, 0.6), 1100, 0)
  assert.equal(t.turn?.dir, '◀', 'no flip inside the cooldown')
  // Clearly on the other side, after the cooldown: now it flips.
  t = observe(t, box(0.75, 0.4, 0.95, 0.6), 1000 + ANCHOR.turnFlipCooldownMs + 100, 0)
  assert.equal(t.turn?.dir, '▶')
})

test('every mode has a look and a reason, and none of them is a dead control', () => {
  const beacon = observe(emptyTrack(), box(0.47, 0.47, 0.53, 0.53), 1000, 0.9)
  assert.equal(chipMode(beacon, 1000, 0.9, false), 'beacon')
  assert.equal(chipLabel('beacon', 'swim to statue', '▶'), '◆ get closer')
  assert.equal(chipLabel('turn', 'swim to statue', '◀'), '◀ turn to face')
  assert.equal(chipLabel('armed', 'swim to statue', '▶'), 'swim to statue')
  assert.equal(chipRefusal(beacon, 'Swim to statue'), 'Walk closer to swim to statue')

  const side = observe(emptyTrack(), box(0.0, 0.4, 0.1, 0.6), 1000, 0)
  assert.equal(chipRefusal(side, 'Swim to statue'), 'Turn to face it — Swim to statue')
  assert.equal(chipMode(side, 1000, 0, true), 'sending', 'sending outranks everything')
})

test('the chip tracks the PICTURE, not its container', () => {
  // A 16:9 frame in a 4:3 box. `contain` letterboxes: the picture is 800x450
  // inside 800x600, so a box centred vertically lands at the middle of the
  // PICTURE (300/600 = 50%), not of the container.
  const c = boxToPercent([0.4, 0.4, 0.6, 0.6], { w: 1600, h: 900 }, { w: 800, h: 600 }, 'contain')
  assert.equal(Math.round(c.leftPct), 50)
  assert.equal(Math.round(c.topPct), 50)
  // Off-centre in the frame → off-centre by the PICTURE's scale, which is
  // smaller than the container's, so the offset shrinks.
  const off = boxToPercent([0.0, 0.0, 0.2, 0.2], { w: 1600, h: 900 }, { w: 800, h: 600 }, 'contain')
  assert.equal(Math.round(off.leftPct), 10)
  assert.equal(Math.round(off.topPct), 20, '450px picture, 75px offset, 600px box')
  // Degenerate dimensions (video not yet painted) fall back to raw fractions
  // instead of dividing by zero.
  const raw = boxToPercent([0.2, 0.2, 0.4, 0.4], { w: 0, h: 0 }, { w: 800, h: 600 }, 'cover')
  assert.equal(Math.round(raw.leftPct), 30)
})

test('the rail obeys the flag algebra, not just the current state', () => {
  // `requires`/`grants`/`oneShot` were stored, authored, drawn and LINTED while
  // the player evaluated none of them — a locked door that opened for anyone,
  // and a doctrine rule (`unreachable-require`) policing a mechanic that did
  // not exist. These are that mechanic.
  const beats = [
    { name: 'open_door', from: ['hall'], requires: ['has_key'] },
    { name: 'take_key', from: ['hall'], oneShot: true },
    { name: 'look', from: [] },
    { name: 'elsewhere', from: ['attic'] },
  ]
  const none = new Set<string>()

  // In `hall` with no flags: the locked door is not offered, the key and the
  // from-anywhere look are.
  assert.deepEqual(legalBeats(beats, 'hall', none, none).map((b) => b.name), ['take_key', 'look'])

  // Holding the flag unlocks it.
  assert.deepEqual(
    legalBeats(beats, 'hall', new Set(['has_key']), none).map((b) => b.name),
    ['open_door', 'take_key', 'look'],
  )

  // A spent one-shot is gone for the rest of the run.
  assert.deepEqual(
    legalBeats(beats, 'hall', new Set(['has_key']), new Set(['take_key'])).map((b) => b.name),
    ['open_door', 'look'],
  )

  // An empty `from` really does mean anywhere — including nowhere yet.
  assert.deepEqual(legalBeats(beats, null, none, none).map((b) => b.name), ['look'])
})

/**
 * An UNPROBED anchor must still hold the aim gate shut.
 *
 * Found by playing what the kernel writes, on a live Reactor session. An anchor
 * carries a measured `minProximity` only when a first frame was painted and
 * probed — and this studio's whole quick start is "no account, no key", so a new
 * author with no image provider generates a world whose every anchor has none.
 * Both play-time sites then read `?? 0`, which makes the chip actionable the
 * moment the detector returns ANY box: the doctrine's own `sliver-evidence`
 * defect, live ("a sliver at the frame edge counts, so the chip arms from
 * across the room").
 *
 * The camera showed the healthy half: a PROBED world (minProximity 0.135) held
 * three chips in "turn to face" while its objects were off-centre. The gate
 * works — an unprobed world just was not being given a number to gate on.
 * DEFAULT_PROXIMITY is the shared constant for the same "get close" idea,
 * already used by the mission compiler.
 */
test('a sliver does not arm an anchor that was never probed', () => {
  const now = 1000
  // A 4%-of-frame box, dead centre — small enough to be scenery, aimed enough
  // that centring is not what is holding it.
  const sliver = box(0.48, 0.48, 0.52, 0.52)
  const withZero = observe(emptyTrack(), sliver, now, 0)
  const withDefault = observe(emptyTrack(), sliver, now, DEFAULT_PROXIMITY)

  assert.equal(isActionable(withZero, now, 0), true, 'this is the old behaviour, and the bug')
  assert.equal(
    isActionable(withDefault, now, DEFAULT_PROXIMITY),
    false,
    'the shipped default keeps a distant object out of reach',
  )

  // And the gate opens when the player actually gets close.
  const near = box(0.3, 0.3, 0.7, 0.7)
  const closed = observe(emptyTrack(), near, now, DEFAULT_PROXIMITY)
  assert.equal(isActionable(closed, now, DEFAULT_PROXIMITY), true, 'a gate that never opens is not a gate')
})

/**
 * ...and both play-time sites must actually USE that fallback.
 *
 * The test above pins the mechanism inside `anchors.ts`; it passes whatever the
 * player chooses to pass in. The defect lived in the two call sites, so this
 * pins them — and they must agree, because the tracker and the renderer gating
 * on different numbers is a chip that looks armed and refuses the click.
 */
test('the player gates an unprobed anchor on the shipped default, not on zero', async () => {
  const { readFileSync } = await import('node:fs')
  for (const file of ['../../src/play/Chips.tsx', '../../src/play/Player.tsx']) {
    const src = readFileSync(new URL(file, import.meta.url), 'utf8')
    assert.match(src, /minProximity \?\? DEFAULT_PROXIMITY/, `${file} falls back to the shipped default`)
    assert.doesNotMatch(src, /minProximity \?\? 0\b/, `${file} must not fall back to zero — a sliver arms at 0`)
  }
})

// "It is an ending" is a claim about the WORLD, not about the studio.
//
// The beat bar showed that sentence whenever `legalBeats` returned nothing —
// and it returns nothing for two unrelated reasons. During a campaign hand-off
// the player's `stateId` is briefly null while one act's world is swapped for
// the next, every beat is filtered out because none are anchored to `null`, and
// the studio announced the story was over while it was loading the next act. A
// recording caught the bar empty at exactly that moment (`on offer: []`).
test('an unresolved state is not reported to the player as an ending', () => {
  assert.equal(
    beatBarNote(null, 0),
    'finding your place in the world…',
    'not knowing where you are is the studio\'s problem, and it says so',
  )
  assert.match(beatBarNote('mud_secret', 0) ?? '', /it is an ending/,
    'a state that really has no way out still says so')
  assert.equal(beatBarNote(null, 2), null, 'and with beats on offer it says nothing at all')
  assert.equal(beatBarNote('opening', 1), null)
})
