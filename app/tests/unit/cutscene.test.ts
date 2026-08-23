/**
 * Clips on the seams.
 *
 * Two rules, both easy to lose because they
 * only show up when something is unusual:
 *   · a transition's `to` resolves CUTSCENE ids before state ids;
 *   · a missing clip FAILS OPEN, so a world is playable before its art lands.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { resolveDestination, cutscenesFrom } from '../../src/play/cutscene'
import { LocalWorldStore } from '../../src/world/store/local'
import { fileStore, defaultStorePath } from '../../src/world/store/file.node'
import { unwrapWorldDoc } from '../../src/world'
import type { SMCutscene } from '../../src/world'

const CUTS: SMCutscene[] = [
  { id: 'c1', video: '/clips/the-grab.webm', from: 'lane', to: 'orchard_gate' },
  { id: 'c2', video: '/clips/the-fall.webm', from: 'lane', to: 'bench_under_trees', requires: ['saw_it'] },
]

test('a transition resolves CUTSCENES before states', () => {
  assert.deepEqual(resolveDestination('c1', CUTS, new Set()), {
    kind: 'cutscene', cutscene: CUTS[0], state: 'orchard_gate',
  })
  assert.deepEqual(resolveDestination('orchard_gate', CUTS, new Set()), { kind: 'state', state: 'orchard_gate' })
  assert.equal(resolveDestination(undefined, CUTS, new Set()), null)
  assert.deepEqual(resolveDestination('c1', undefined, new Set()), { kind: 'state', state: 'c1' })
})

test('a GATED cut the player cannot satisfy is skipped, not blocked', () => {
  // Its destination is where they were going anyway — a flag they do not hold
  // must not strand them on a seam.
  assert.deepEqual(resolveDestination('c2', CUTS, new Set()), { kind: 'state', state: 'bench_under_trees' })
  assert.deepEqual(resolveDestination('c2', CUTS, new Set(['saw_it'])), {
    kind: 'cutscene', cutscene: CUTS[1], state: 'bench_under_trees',
  })
})

test('the cuts on a seam are the ones that leave that state', () => {
  assert.deepEqual(cutscenesFrom(CUTS, 'lane').map((c) => c.id), ['c1', 'c2'])
  assert.deepEqual(cutscenesFrom(CUTS, 'orchard_gate'), [])
  assert.deepEqual(cutscenesFrom(CUTS, null), [])
  assert.deepEqual(cutscenesFrom(undefined, 'lane'), [])
})

test('the store checks the seam it bridges, and NOT the clip', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'studio-cut-'))
  try {
    const store = new LocalWorldStore(fileStore(defaultStorePath({ STUDIO_HOME: dir })))
    const created = await store.createWorld({ template: 'starter' }, 'k')
    const id = created.worldId ?? ''
    let rev = (await store.getScene(id)).rev

    // A clip that does not exist yet is FINE — that is the point of fail-open,
    // and a store refusing unmade art would make it impossible to author.
    await store.applyOps(id, [
      { op: 'add_cutscene', id: 'c1', video: '/clips/not-made-yet.webm', from: 'lane', to: 'orchard_gate' },
    ], rev)
    const world = unwrapWorldDoc(await store.getWorld(id))
    assert.equal(world.cutscenes?.length, 1)
    assert.equal(world.cutscenes?.[0]?.video, '/clips/not-made-yet.webm')

    rev = (await store.getScene(id)).rev
    // …but a seam that lands nowhere is not.
    await assert.rejects(
      () => store.applyOps(id, [{ op: 'add_cutscene', id: 'c9', video: '/x.webm', from: 'lane', to: 'nowhere' }], rev),
      /No state "nowhere"/,
    )
    // …and an id that shadows a state would make itself unreachable, because
    // cutscenes resolve first.
    await assert.rejects(
      () => store.applyOps(id, [{ op: 'add_cutscene', id: 'lane', video: '/x.webm', from: 'lane', to: 'orchard_gate' }], rev),
      /already a state id/,
    )

    await store.applyOps(id, [{ op: 'remove_cutscene', id: 'c1' }], rev)
    assert.deepEqual(unwrapWorldDoc(await store.getWorld(id)).cutscenes, [])
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
