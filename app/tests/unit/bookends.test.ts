/**
 * The clip at the start and the clip at the end.
 *
 * Both are cutscenes with one special rule each, and the rules are what these
 * tests are for: an outro is EARNED and plays once, and how a world comes out
 * of an intro depends on how the author's clip ends.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { outroDue, bootAfterIntro } from '../../src/play/bookends'
import { LocalWorldStore } from '../../src/world/store/local'
import { fileStore, defaultStorePath } from '../../src/world/store/file.node'
import { unwrapWorldDoc } from '../../src/world'

const OUTRO = { video: '/clips/home.webm', flag: 'delivered', state: 'bench_under_trees' }

test('the outro is a CONDITION, not a destination — and it plays once', () => {
  // Flag without the state, state without the flag: neither is the moment.
  assert.equal(outroDue(OUTRO, 'lane', new Set(['delivered']), false), false)
  assert.equal(outroDue(OUTRO, 'bench_under_trees', new Set(), false), false)
  assert.equal(outroDue(OUTRO, 'bench_under_trees', new Set(['delivered']), false), true)

  // Once. Replaying a victory the player already had is worse than not playing
  // it — they would think they had lost it.
  assert.equal(outroDue(OUTRO, 'bench_under_trees', new Set(['delivered']), true), false)
  assert.equal(outroDue(undefined, 'bench_under_trees', new Set(['delivered']), false), false)
  assert.equal(outroDue(OUTRO, null, new Set(['delivered']), false), false)
})

test('how the world comes out of an intro is what the clip did', () => {
  // The default: the clip ends mid-motion and the boot continues it.
  assert.deepEqual(bootAfterIntro(undefined), { moving: true, driveToken: 'Front' })
  assert.deepEqual(bootAfterIntro(false), { moving: true, driveToken: 'Front' })
  // A still ending needs the opposite, or the cut is visible.
  assert.deepEqual(bootAfterIntro(true), { moving: false, driveToken: null })
})

test('the store keeps both, and refuses an outro that can never come true', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'studio-book-'))
  try {
    const store = new LocalWorldStore(fileStore(defaultStorePath({ STUDIO_HOME: dir })))
    const created = await store.createWorld({ template: 'starter' }, 'k')
    const id = created.worldId ?? ''
    let rev = (await store.getScene(id)).rev

    await store.applyOps(id, [
      { op: 'set_intro', video: '/clips/open.webm', static: true },
      { op: 'set_outro', video: '/clips/home.webm', flag: 'delivered', state: 'bench_under_trees' },
    ], rev)
    let world = unwrapWorldDoc(await store.getWorld(id))
    assert.equal(world.introVideo, '/clips/open.webm')
    assert.equal(world.introStatic, true)
    assert.deepEqual(world.outro, { video: '/clips/home.webm', flag: 'delivered', state: 'bench_under_trees' })

    // An outro naming a room the world does not have could never fire, and
    // nothing would ever say so.
    rev = (await store.getScene(id)).rev
    await assert.rejects(
      () => store.applyOps(id, [{ op: 'set_outro', video: '/x.webm', flag: 'f', state: 'nowhere' }], rev),
      /No state "nowhere"/,
    )

    // Both are removable, which is how an author drops a clip they cut.
    await store.applyOps(id, [{ op: 'set_intro', video: null }, { op: 'set_outro', video: null }], rev)
    world = unwrapWorldDoc(await store.getWorld(id))
    assert.equal(world.introVideo, undefined)
    assert.equal(world.outro, undefined)
    assert.equal(world.introStatic, true, 'and dropping the clip does not forget how it ended')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
