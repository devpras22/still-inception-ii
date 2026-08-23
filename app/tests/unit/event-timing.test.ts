/**
 * An event's own framing and timing, WRITTEN THROUGH THE STORE.
 *
 * The defect this shape of test exists for, hit five separate times here: a
 * field the schema carries and the store DROPS is invisible, because the op
 * reports success. So these
 * assert what came back OUT of the store, never what went into the op — and
 * they check the numbers are validated, since `mergePatch` carries every
 * remaining key through untouched and a string where a duration belongs would
 * reach the player as NaN and hold a beat forever.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { LocalWorldStore } from '../../src/world/store/local'
import { fileStore, defaultStorePath } from '../../src/world/store/file.node'

async function fresh() {
  const dir = mkdtempSync(join(tmpdir(), 'studio-timing-'))
  const store = new LocalWorldStore(fileStore(defaultStorePath({ STUDIO_HOME: dir })))
  const created = await store.createWorld({ template: 'starter' }, 'k')
  return { store, id: created.worldId ?? '', dir }
}

test('add_event carries camera, movement, minPlayMs and autoAfterMs through the store', async () => {
  const { store, id, dir } = await fresh()
  try {
    const rev = (await store.getScene(id)).rev
    await store.applyOps(id, [
      {
        op: 'add_event',
        name: 'slip_through',
        kind: 'transition',
        from: ['lane'],
        to: 'orchard_gate',
        base: 'Slipping through the gap in the wall.',
        camera: 'low and close, following through the gap',
        movement: 'striding forward, one hand out',
        minPlayMs: 4000,
        autoAfterMs: 3500,
      },
    ], rev)

    const ev = (await store.getScene(id)).events.find((e) => e.name === 'slip_through')
    assert.equal(ev?.camera, 'low and close, following through the gap')
    assert.equal(ev?.movement, 'striding forward, one hand out')
    assert.equal(ev?.minPlayMs, 4000)
    assert.equal(ev?.autoAfterMs, 3500)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('update_event edits them, and null ERASES rather than being ignored', async () => {
  const { store, id, dir } = await fresh()
  try {
    let rev = (await store.getScene(id)).rev
    await store.applyOps(id, [{ op: 'update_event', name: 'go_to_the_bench', patch: { camera: 'wide, the bench centred', minPlayMs: 6000 } }], rev)
    let ev = (await store.getScene(id)).events.find((e) => e.name === 'go_to_the_bench')
    assert.equal(ev?.camera, 'wide, the bench centred')
    assert.equal(ev?.minPlayMs, 6000)

    rev = (await store.getScene(id)).rev
    await store.applyOps(id, [{ op: 'update_event', name: 'go_to_the_bench', patch: { camera: null, minPlayMs: null } }], rev)
    ev = (await store.getScene(id)).events.find((e) => e.name === 'go_to_the_bench')
    assert.equal(ev?.camera, undefined, 'an emptied field is gone, not stale')
    assert.equal(ev?.minPlayMs, undefined)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('a duration that is not a number is refused at the boundary', async () => {
  const { store, id, dir } = await fresh()
  try {
    const rev = (await store.getScene(id)).rev
    await assert.rejects(
      () => store.applyOps(id, [{ op: 'update_event', name: 'go_to_the_bench', patch: { minPlayMs: 'soon' } }], rev),
      /"minPlayMs" must be a non-negative number/,
    )
    await assert.rejects(
      () => store.applyOps(id, [{ op: 'add_event', name: 'x', kind: 'transition', from: ['lane'], to: 'bench_under_trees', autoAfterMs: -1 }], rev),
      /"autoAfterMs" must be a non-negative number/,
    )
    await assert.rejects(
      () => store.applyOps(id, [{ op: 'update_event', name: 'go_to_the_bench', patch: { camera: 42 } }], rev),
      /"camera" must be a string/,
    )
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
