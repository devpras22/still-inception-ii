/**
 * The doctrine's three newest rules, and the creator-facing half of all of them.
 *
 * These three were listed for months as "not portable — the OSS schema has no
 * such field", and two of those claims were simply stale (`requires`/`grants`
 * were always on `SMEvent`) while the third needed a translation nobody had
 * made yet: the fork gates the play-time chip on `anchor.minProximity`, and a
 * missing size minimum on an anchored interaction is the defect. A rule that
 * exists but never fires is decorative, so each test below makes the rule FIRE
 * on a world shaped to break it — and stay silent on one that is fine.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { LocalWorldStore } from '../../src/world/store/local'
import { fileStore, defaultStorePath } from '../../src/world/store/file.node'
import { runDoctrine } from '../../src/world/doctrine'
import { autoFixOps, canAutoFix, lintTitle, lintWhat, LINT_HELP, DEFAULT_MIN_PROXIMITY } from '../../src/world/lintHelp'
import type { SMWorld } from '../../src/world/api'

/** A minimal world that is otherwise clean, so each test's lint is the only
 *  thing that could explain its diagnostic. */
function world(events: SMWorld['scene']['events']): SMWorld {
  return {
    entrance: { state: 'a' },
    scene: {
      states: {
        a: { base: 'A quiet room with a table.', camera: { static: 'eye level', dynamic: 'eye level, drifting' }, movement: { static: 'standing still', dynamic: 'walking' } },
        b: { base: 'A hallway that ends the story.', ending: { kind: 'win' }, camera: { static: 'eye level', dynamic: 'eye level, drifting' }, movement: { static: 'standing still', dynamic: 'walking' } },
      },
      events,
    },
  } as unknown as SMWorld
}

const hits = (w: SMWorld, lint: string) => runDoctrine(w).filter((d) => d.lint === lint)

test('unreachable-require: a locked door with no key anywhere', () => {
  const locked = world([
    { name: 'open_door', kind: 'transition', from: ['a'], to: 'b', requires: ['has_key'], base: 'The door swings wide.' },
  ])
  const found = hits(locked, 'unreachable-require')
  assert.equal(found.length, 1)
  assert.match(found[0]!.message, /has_key/)
  assert.equal(found[0]!.severity, 'error')

  // Grant it anywhere in the world and the rule goes quiet — it is about the
  // world's flag algebra, not about one event's shape.
  const keyed = world([
    { name: 'take_key', kind: 'override', from: ['a'], grants: ['has_key'], base: 'The key lifts off the table.' },
    { name: 'open_door', kind: 'transition', from: ['a'], to: 'b', requires: ['has_key'], base: 'The door swings wide.' },
  ])
  assert.equal(hits(keyed, 'unreachable-require').length, 0)
})

test('lethal-override: a death the world takes back', () => {
  const lethal = world([
    { name: 'fight', kind: 'override', from: ['a'], base: 'The guard is killed and the room falls quiet.' },
  ])
  const found = hits(lethal, 'lethal-override')
  assert.equal(found.length, 1)
  assert.equal(found[0]!.severity, 'error')

  // The same prose in a TRANSITION is fine: it lands in a changed state and
  // stays changed. The rule is about the override's snap-back, not the word.
  const moved = world([
    { name: 'fight', kind: 'transition', from: ['a'], to: 'b', base: 'The guard is killed and the room falls quiet.' },
  ])
  assert.equal(hits(moved, 'lethal-override').length, 0)
})

test('lethal-override does NOT false-fire on ordinary scene prose', () => {
  // The carve-out, and the reason the regex is not the obvious one: "dead"
  // and "shot" are everyday scene words.
  const fine = world([
    { name: 'look', kind: 'override', from: ['a'], base: 'A wide shot of dead neon over the counter.' },
  ])
  assert.equal(hits(fine, 'lethal-override').length, 0)
})

test('sliver-evidence: an anchored interaction with no minimum size', () => {
  const sliver = world([
    { name: 'touch_table', kind: 'override', from: ['a'], base: 'A hand settles on the table.', anchor: { label: 'the table' } },
  ])
  const found = hits(sliver, 'sliver-evidence')
  assert.equal(found.length, 1)
  // A warning, not an error: the probe only measures a proximity for thin
  // objects, so a wide anchor legitimately has none.
  assert.equal(found[0]!.severity, 'warning')

  const measured = world([
    { name: 'touch_table', kind: 'override', from: ['a'], base: 'A hand settles on the table.', anchor: { label: 'the table', minProximity: 0.2 } },
  ])
  assert.equal(hits(measured, 'sliver-evidence').length, 0)
})

test('the one-click fix writes the measured minimum, and only that', () => {
  const w = world([
    { name: 'touch_table', kind: 'override', from: ['a'], base: 'A hand settles on the table.', anchor: { label: 'the table', aliases: ['table'] } },
  ])
  const d = hits(w, 'sliver-evidence')[0]!
  assert.equal(canAutoFix(d), true)

  const ops = autoFixOps(w, d)
  assert.equal(ops.length, 1)
  assert.equal(ops[0]!['op'], 'update_event')
  assert.equal(ops[0]!['name'], 'touch_table')
  const anchor = (ops[0]!['patch'] as { anchor: Record<string, unknown> }).anchor
  assert.equal(anchor['minProximity'], DEFAULT_MIN_PROXIMITY)
  // The label and the probe's verified aliases survive: a fix that quietly
  // dropped them would break the detect query the chip runs.
  assert.equal(anchor['label'], 'the table')
  assert.deepEqual(anchor['aliases'], ['table'])

  // Nothing to do twice.
  const fixed = world([
    { name: 'touch_table', kind: 'override', from: ['a'], base: 'A hand settles on the table.', anchor: { label: 'the table', minProximity: 0.15 } },
  ])
  assert.deepEqual(autoFixOps(fixed, d), [])
})

test('a lint with no safe fix has no button', () => {
  const w = world([{ name: 'go', kind: 'transition', from: ['a'], to: 'nowhere', base: 'Onward.' }])
  const d = hits(w, 'dangling-ref')[0]!
  assert.equal(canAutoFix(d), false)
  assert.deepEqual(autoFixOps(w, d), [])
})

test('every rule the doctrine can raise speaks to a creator', () => {
  // The panel shows `lintTitle`, so a code with no entry would surface as a
  // humanized slug — fine as a fallback, not fine as the shipped state. This
  // pins the catalogue against the rules that actually exist.
  const codes = [
    'negation', 'whiteout', 'dangling-ref', 'transition-needs-to', 'unreachable-require',
    'lethal-override', 'sliver-evidence', 'budget', 'no-entrance', 'entrance-missing-state',
    'unreachable-state', 'no-ending', 'orphan-event',
  ]
  for (const code of codes) {
    assert.ok(LINT_HELP[code], `${code} has no creator-facing help`)
    assert.notEqual(lintTitle(code), code, `${code} still shows its raw id`)
    assert.ok(lintWhat(code).length > 40, `${code}'s explanation says nothing useful`)
  }
  // …and an unknown code degrades instead of throwing.
  assert.equal(lintTitle('foo-bar'), 'Foo bar')
})

test('the fix WRITES: through the real store, on the world the studio ships', async () => {
  // The shape matters and is invisible: `update_event` DROPS an `event` key and
  // applies `patch`, so the wrong shape is not an error — it is an op that
  // reports success and changes nothing. Both this fix and the authoring run's
  // anchor-grounding shipped with that bug; only a write-and-read-back catches
  // it, which is why this test drives the actual store rather than asserting on
  // the op object.
  const dir = mkdtempSync(join(tmpdir(), 'studio-doctrine-'))
  try {
    const store = new LocalWorldStore(fileStore(defaultStorePath({ STUDIO_HOME: dir })))
    const created = await store.createWorld({ template: 'starter' })
    const id = created.worldId!
    const before = await store.getScene(id)
    const w = { id, scene: { states: before.states, events: before.events } } as unknown as SMWorld

    const d = runDoctrine(w).find((x) => x.lint === 'sliver-evidence')
    assert.ok(d, 'the shipped example world must carry exactly the lint it exists to demonstrate')

    const ops = autoFixOps(w, d)
    await store.applyOps(id, ops, before.rev)

    const after = await store.getScene(id)
    const name = /^events\.([^.]+)/.exec(d.path)![1]
    const fixed = after.events.find((e) => e.name === name)
    assert.equal(fixed?.anchor?.minProximity, DEFAULT_MIN_PROXIMITY, 'the write landed')
    assert.equal(fixed?.anchor?.label, 'the bench', 'and did not clobber the detect query')

    // The lint it was raised for is gone, and no new one took its place.
    const afterW = { id, scene: { states: after.states, events: after.events } } as unknown as SMWorld
    assert.equal(runDoctrine(afterW).filter((x) => x.lint === 'sliver-evidence').length, 0)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('shared-phase-camera: one camera narrating a whole sequence', () => {
  const shared = world([
    {
      name: 'step_out', kind: 'transition', from: ['a'], to: 'b', base: 'Crossing the threshold.',
      phases: [
        { base: 'A hand on the door, the room still behind.', camera: 'close on the handle' },
        { base: 'The doorway passing overhead.' },
      ],
    },
  ])
  const found = hits(shared, 'shared-phase-camera')
  assert.equal(found.length, 1)
  assert.equal(found[0]!.severity, 'warning')
  assert.match(found[0]!.message, /2 phases and 1 of them/)

  // Give every beat its own camera and the rule goes quiet.
  const own = world([
    {
      name: 'step_out', kind: 'transition', from: ['a'], to: 'b', base: 'Crossing the threshold.',
      phases: [
        { base: 'A hand on the door, the room still behind.', camera: 'close on the handle' },
        { base: 'The doorway passing overhead.', camera: 'tilted up at the lintel' },
      ],
    },
  ])
  assert.equal(hits(own, 'shared-phase-camera').length, 0)
  // A single-phase event is not a sequence and cannot share anything.
  const one = world([
    { name: 'step_out', kind: 'transition', from: ['a'], to: 'b', base: 'Out.', phases: [{ base: 'Out.' }] },
  ])
  assert.equal(hits(one, 'shared-phase-camera').length, 0)
})

test('auto-needs-pixels: a trigger zone with nothing to watch', () => {
  const blind = world([
    { name: 'walk_out', kind: 'transition', from: ['a'], to: 'b', base: 'Outside.', landWhen: { label: 'door', auto: true } },
  ])
  const found = hits(blind, 'auto-needs-pixels')
  assert.equal(found.length, 1)
  assert.equal(found[0]!.severity, 'error')

  // Luminance or motion makes it fireable — the signals the runtime honours.
  for (const when of [{ minLuminance: 90, auto: true }, { maxMotion: 4, auto: true }]) {
    const ok = world([{ name: 'walk_out', kind: 'transition', from: ['a'], to: 'b', base: 'Outside.', landWhen: when }])
    assert.equal(hits(ok, 'auto-needs-pixels').length, 0)
  }
  // Without auto it is a pressed transition and a label is perfectly fine.
  const pressed = world([
    { name: 'walk_out', kind: 'transition', from: ['a'], to: 'b', base: 'Outside.', landWhen: { label: 'door', minExtent: 0.2 } },
  ])
  assert.equal(hits(pressed, 'auto-needs-pixels').length, 0)
})

test('luminance-overlap: only a genuine round trip oscillates', () => {
  const loop = world([
    { name: 'go_out', kind: 'transition', from: ['a'], to: 'b', base: 'Into the light.', landWhen: { minLuminance: 80 } },
    { name: 'go_back', kind: 'transition', from: ['b'], to: 'a', base: 'Back inside.', landWhen: { maxLuminance: 95 } },
  ])
  const found = hits(loop, 'luminance-overlap')
  assert.equal(found.length, 1)
  assert.equal(found[0]!.severity, 'error')

  // Separate the bands and the pair is stable.
  const apart = world([
    { name: 'go_out', kind: 'transition', from: ['a'], to: 'b', base: 'Into the light.', landWhen: { minLuminance: 90 } },
    { name: 'go_back', kind: 'transition', from: ['b'], to: 'a', base: 'Back inside.', landWhen: { maxLuminance: 40 } },
  ])
  assert.equal(hits(apart, 'luminance-overlap').length, 0)

  // Two events that merely share a band are not a loop.
  const unrelated = world([
    { name: 'go_out', kind: 'transition', from: ['a'], to: 'b', base: 'Into the light.', landWhen: { minLuminance: 80 } },
    { name: 'go_deeper', kind: 'transition', from: ['a'], to: 'b', base: 'Deeper.', landWhen: { maxLuminance: 95 } },
  ])
  assert.equal(hits(unrelated, 'luminance-overlap').length, 0)
})

test('the store CARRIES phases and landWhen — the fields the rules read', async () => {
  // add_event once built its event from an allowlist, so a whole capability
  // could exist in the type, be authored by the kernel, pass every lint, and
  // never reach the player. Same test shape as the anchor one, same reason.
  const dir = mkdtempSync(join(tmpdir(), 'studio-schema-'))
  try {
    const store = new LocalWorldStore(fileStore(defaultStorePath({ STUDIO_HOME: dir })))
    const created = await store.createWorld({ premise: 'a lit doorway' })
    const id = created.worldId!
    const before = await store.getScene(id)
    await store.applyOps(id, [
      { op: 'add_state', id: 'outside', base: 'A rear-view shot of a figure on a bright step.' },
      {
        op: 'add_event', name: 'step_out', kind: 'transition', from: ['opening'], to: 'outside',
        base: 'Crossing the threshold.',
        phases: [{ base: 'A hand on the door.', camera: 'close on the handle', minMs: 3000 }],
        landWhen: { minLuminance: 90, hits: 2, auto: true },
      },
    ] as never, before.rev)
    const after = await store.getScene(id)
    const ev = after.events.find((e) => e.name === 'step_out')
    assert.equal(ev?.phases?.length, 1, 'phases survived add_event')
    assert.equal(ev?.phases?.[0]?.camera, 'close on the handle')
    assert.equal(ev?.landWhen?.minLuminance, 90, 'landWhen survived add_event')
    assert.equal(ev?.landWhen?.hits, 2)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

// A mission that broke its own grounding is reported by the DOCTRINE.
//
// `missionGrounding` could answer this from a stored world the moment the probe
// set was persisted, and for one iteration nothing in the product asked it — a
// guard with no call site, which this codebase calls decorative. The doctrine is
// where the question belongs, because it outlives the authoring run: a mission
// hand-edited in the inspector afterwards can break a rule the quest's own
// correction rounds enforced at write time, and nothing else would notice.
test('an objective acting on a noun the probe never found is reported', () => {
  const objective = (id: string, target: string) => ({
    id, text: `do ${id}`, location: 'opening', action: 'x', outcome: 'y', grants: id,
    grounded: { target, confirm: 'z' },
  })
  const world = (mission: Record<string, unknown>): SMWorld => ({
    entrance: { state: 'opening' },
    scene: {
      states: { opening: { base: 'a yard' } },
      // The flags are granted, so `objective-unreachable` stays quiet and this
      // test can only fail for the reason it is about.
      events: [
        { name: 'a', kind: 'override', from: ['opening'], base: 'x', grants: ['seal'] },
        { name: 'b', kind: 'override', from: ['opening'], base: 'x', grants: ['light'] },
      ],
    },
    missions: [mission as never],
  })

  const hits = (w: SMWorld) => runDoctrine(w).filter((d) => d.lint === 'objective-ungrounded')

  // Grounded on what the probe found: silent.
  assert.deepEqual(hits(world({ id: 'm', title: 'M', verified: ['floodgate'],
    objectives: [objective('seal', 'floodgate')] })), [])

  // Grounded on something invented: reported, naming the target and the reason
  // a player cares — they may not be able to see it, let alone act on it.
  const bad = hits(world({ id: 'm', title: 'M', verified: ['floodgate'],
    objectives: [objective('seal', 'floodgate'), objective('light', 'lantern')] }))
  assert.equal(bad.length, 1)
  assert.match(bad[0]!.message, /lantern/)
  assert.equal(bad[0]!.severity, 'warning',
    'a warning, not an error: the doctrine blocks play on errors, and a probe can miss a thing that is really there')

  // A mission with no probe set is not held to a rule it was never built under.
  assert.deepEqual(hits(world({ id: 'm', title: 'M',
    objectives: [objective('seal', 'lantern')] })), [])
})
