/**
 * Set-pieces: an ordered chain of states played as ONE unit.
 *
 * The pacing is the whole difference between a set-piece and four states in a
 * row — the UFO has to ARRIVE before the tank appears — so the plan is a value
 * and the dwells are what these tests are about.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { sequencePlan, sequencesFrom, settleSatisfiable, SequenceError, SETTLE_GATE } from '../../src/play/sequence'
import { deterministicTrigger, safeDirectives } from '../../src/play/director'
import { LocalWorldStore } from '../../src/world/store/local'
import { fileStore, defaultStorePath } from '../../src/world/store/file.node'
import { unwrapWorldDoc } from '../../src/world'
import type { SMScene, SMSequence } from '../../src/world'

const STATES = { lane: {}, orchard_gate: {}, bench_under_trees: {} }

function seq(beats: SMSequence['beats']): SMSequence {
  return { id: 'arrival', title: 'The gate opens', beats }
}

test('a plan resolves every dwell, and SETTLE waits on the same evidence a crossing does', () => {
  const plan = sequencePlan(
    seq([{ state: 'lane' }, { state: 'orchard_gate', dwell: { ms: 2500 } }, { state: 'bench_under_trees', dwell: 'input' }]),
    STATES,
  )
  assert.deepEqual(plan.map((b) => b.state), ['lane', 'orchard_gate', 'bench_under_trees'])
  // The default is settle — a beat that has landed is a beat whose picture has
  // stopped moving, which is the same signature a verified arrival uses.
  assert.equal(plan[0]?.dwell, 'settle')
  assert.deepEqual(plan[0]?.gate, SETTLE_GATE)
  assert.deepEqual(plan[1]?.dwell, { ms: 2500 })
  assert.equal(plan[1]?.gate, undefined, 'a timer waits on the clock, not on the picture')
  assert.equal(plan[2]?.dwell, 'input')
})

test('a beat naming a state the world no longer has is refused, not walked into', () => {
  assert.throws(
    () => sequencePlan(seq([{ state: 'lane' }, { state: 'a_deleted_room' }]), STATES),
    (e: unknown) => e instanceof SequenceError && /beat 2 enters "a_deleted_room"/.test(e.message),
  )
  assert.throws(() => sequencePlan(seq([]), STATES), /has no beats/)
})

test('a set-piece is offered where it STARTS', () => {
  const sequences = [seq([{ state: 'orchard_gate' }, { state: 'bench_under_trees' }])]
  assert.deepEqual(sequencesFrom(sequences, 'orchard_gate').map((q) => q.id), ['arrival'])
  assert.deepEqual(sequencesFrom(sequences, 'bench_under_trees'), [], 'not from the middle of itself')
  assert.deepEqual(sequencesFrom(sequences, null), [])
  assert.deepEqual(sequencesFrom(undefined, 'orchard_gate'), [])
})

test('the DIRECTOR plays a fresh set-piece rather than firing its doorway', () => {
  // The ordering, and its reason: a set-piece may also add an entry
  // transition, and firing that would run the first beat and abandon the rest.
  const before = new Set(['old_event'])
  const after = [
    { name: 'old_event', kind: 'transition', from: ['lane'], to: 'orchard_gate' },
    { name: 'the_gate_opens', kind: 'transition', from: ['lane'], to: 'orchard_gate' },
  ] as unknown as SMScene['events']
  const withSeq = deterministicTrigger(before, after, 'lane', {
    beforeIds: new Set<string>(),
    after: [{ id: 'arrival' }],
  })
  assert.deepEqual(withSeq, [{ playSequence: 'arrival' }])

  // With no fresh sequence it falls back to the transition, exactly as before.
  const withoutSeq = deterministicTrigger(before, after, 'lane', { beforeIds: new Set(['arrival']), after: [{ id: 'arrival' }] })
  assert.deepEqual(withoutSeq, [{ fire: 'the_gate_opens' }])
})

test('a set-piece that walks into an ENDING is refused, like every other auto-play', () => {
  const scene = {
    states: { lane: {}, dead: { ending: { kind: 'lose', title: 'Gone' } } },
    events: [],
  } as unknown as SMScene
  const sequences = [
    { id: 'safe', beats: [{ state: 'lane' }] },
    { id: 'fatal', beats: [{ state: 'lane' }, { state: 'dead' }] },
  ]
  assert.deepEqual(safeDirectives(scene, [{ playSequence: 'safe' }], sequences), [{ playSequence: 'safe' }])
  assert.deepEqual(safeDirectives(scene, [{ playSequence: 'fatal' }], sequences), [], 'a bust is the player\'s')
  assert.deepEqual(safeDirectives(scene, [{ playSequence: 'nope' }], sequences), [])
})

test('the store refuses a set-piece whose beats are not in the graph', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'studio-seq-'))
  try {
    const store = new LocalWorldStore(fileStore(defaultStorePath({ STUDIO_HOME: dir })))
    const created = await store.createWorld({ template: 'starter' }, 'k')
    const id = created.worldId ?? ''
    let rev = (await store.getScene(id)).rev

    await assert.rejects(
      () => store.applyOps(id, [{ op: 'add_sequence', id: 'x', title: 'Nope', beats: [{ state: 'a_room_that_is_not_there' }] }], rev),
      /naming a state that exists/,
    )
    await assert.rejects(
      () => store.applyOps(id, [{ op: 'add_sequence', id: 'x', title: 'Nope', beats: [] }], rev),
      /"beats" must be a non-empty array/,
    )

    await store.applyOps(id, [{
      op: 'add_sequence', id: 'arrival', title: 'The gate opens',
      beats: [{ state: 'lane' }, { state: 'orchard_gate', dwell: { ms: 2000 } }],
    }], rev)
    let world = unwrapWorldDoc(await store.getWorld(id))
    assert.equal(world.sequences?.length, 1)
    assert.equal(world.sequences?.[0]?.title, 'The gate opens')
    assert.deepEqual(world.sequences?.[0]?.beats[1]?.dwell, { ms: 2000 })

    rev = (await store.getScene(id)).rev
    await assert.rejects(
      () => store.applyOps(id, [{ op: 'add_sequence', id: 'arrival', title: 'Again', beats: [{ state: 'lane' }] }], rev),
      /already exists/,
    )

    await store.applyOps(id, [{ op: 'remove_sequence', id: 'arrival' }], rev)
    world = unwrapWorldDoc(await store.getWorld(id))
    assert.deepEqual(world.sequences, [])
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('a SETTLE beat cannot be satisfied while no frames are arriving', () => {
  // Measured live: the settle gate is a motion threshold, and a frozen picture
  // measures as a perfectly still one — so "the scene settled" and "the backend
  // stopped sending" are the same number. The player already runs a watchdog
  // for the second case; this is what connects the two.
  assert.equal(settleSatisfiable(false), true)
  assert.equal(settleSatisfiable(true), false, 'a dead stream has not settled, it has stopped')
})
