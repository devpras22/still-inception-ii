/**
 * The revision contract, pinned.
 *
 * Every graph write takes an OPTIONAL rev, and the two ways of calling it are
 * both load-bearing:
 *
 *  - Omit it and the write reads the current revision immediately before writing,
 *    so a script that just wants its change to land always lands it. This is the
 *    terminal's ergonomics — nobody pastes a revision at a prompt.
 *  - Pass the rev you authored against and a stale one is refused with 409, so an
 *    editor tab that fell behind cannot silently clobber an edit it never saw.
 *    This is the app's safety, and it must survive the move to one shared leaf.
 *
 * A single leaf serving both is the whole point; if either behaviour regressed,
 * one of the two callers would be quietly wrong.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { LocalWorldStore } from '../../src/world/store/local'
import { fileStore, defaultStorePath } from '../../src/world/store/file.node'
import { runTool } from '../../src/tool/run'
import { root } from '../../src/tool/root'
import type { ToolContext } from '../../src/tool/define'

function freshCtx(): { ctx: ToolContext; dir: string } {
  const dir = mkdtempSync(join(tmpdir(), 'studio-rev-'))
  const store = new LocalWorldStore(fileStore(defaultStorePath({ STUDIO_HOME: dir })))
  return { ctx: { store, origin: 'app', json: false }, dir }
}

async function worldId(ctx: ToolContext): Promise<string> {
  const created = await runTool(root, 'world.create', { example: true }, ctx)
  return created.ok ? (created.value as { worldId: string }).worldId : ''
}

test('omitting rev always lands: the write reads the current revision itself', async () => {
  const { ctx, dir } = freshCtx()
  try {
    const w = await worldId(ctx)
    // Two writes in a row, neither passing a rev. The second would fail if the
    // leaf reused a captured rev; it succeeds because it reads fresh each time.
    const first = await runTool(root, 'author.state.add', { world: w, base: 'A shore.', id: 'shore' }, ctx)
    const second = await runTool(root, 'author.state.add', { world: w, base: 'A pier.', id: 'pier' }, ctx)
    assert.equal(first.ok, true)
    assert.equal(second.ok, true, 'a second rev-less write still lands')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('a stale rev is refused with a 409 the envelope flags as a conflict', async () => {
  const { ctx, dir } = freshCtx()
  try {
    const w = await worldId(ctx)
    const scene = await runTool(root, 'world.get', { id: w }, ctx)
    const rev0 = scene.ok ? (scene.value as { scene: { rev: string } }).scene.rev : ''

    // Advance the world with a rev-less write, so rev0 is now behind.
    await runTool(root, 'author.state.add', { world: w, base: 'A gate.', id: 'gate' }, ctx)

    // A write pinned to the stale rev0 must be refused, not applied.
    const stale = await runTool(root, 'author.state.add', { world: w, base: 'A moat.', id: 'moat', rev: rev0 }, ctx)
    assert.equal(stale.ok, false)
    if (!stale.ok) {
      assert.equal(stale.error.status, 409)
      assert.equal(stale.error.conflict, true, 'the envelope precomputes the reload-and-retry signal')
    }

    // And the refused write left nothing behind.
    const after = await runTool(root, 'world.get', { id: w }, ctx)
    const states = after.ok ? (after.value as { scene: { states: Record<string, unknown> } }).scene.states : {}
    assert.ok(!('moat' in states), 'a rejected write is a no-op, not a partial')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('the current rev passes untouched — the editor’s own path still works', async () => {
  const { ctx, dir } = freshCtx()
  try {
    const w = await worldId(ctx)
    const scene = await runTool(root, 'world.get', { id: w }, ctx)
    const rev = scene.ok ? (scene.value as { scene: { rev: string } }).scene.rev : ''

    const ok = await runTool(root, 'author.state.add', { world: w, base: 'A tower.', id: 'tower', rev }, ctx)
    assert.equal(ok.ok, true, 'the rev the caller read is accepted')
    if (ok.ok) assert.notEqual(ok.rev, rev, 'and the write returns the advanced rev')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
