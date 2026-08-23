/**
 * The identical-worlds proof.
 *
 * The studio's central claim is that a world authored from the terminal and a
 * world authored by clicking are the SAME world, because both go through one tool
 * tree over one store. This test makes that literal: it drives the exact same
 * authoring sequence twice — once as CLI argv through `dispatch`, once as
 * structured input through the in-process `runTool` bridge — into two separate
 * stores, then reads both graphs back and asserts they are byte-for-byte equal.
 *
 * If the two consumers could ever diverge — a flag parsed differently, a param
 * coerced differently, a write that took a different path — the graphs would
 * differ and this fails. That divergence is the whole thing the one-tree design
 * exists to prevent.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { LocalWorldStore } from '../../src/world/store/local'
import { fileStore, defaultStorePath } from '../../src/world/store/file.node'
import { dispatch } from '../../src/tool/dispatch'
import { runTool } from '../../src/tool/run'
import { root } from '../../src/tool/root'
import type { ToolContext } from '../../src/tool/define'

function freshCtx(tag: string): { ctx: ToolContext; dir: string } {
  const dir = mkdtempSync(join(tmpdir(), `studio-parity-${tag}-`))
  const store = new LocalWorldStore(fileStore(defaultStorePath({ STUDIO_HOME: dir })))
  return { ctx: { store, origin: 'cli', json: false }, dir }
}

interface Scene {
  states: Record<string, unknown>
  events: unknown[]
}

test('the same authoring sequence via CLI argv and via the bridge produces identical graphs', async () => {
  const cli = freshCtx('cli')
  const app = freshCtx('app')
  try {
    // ── Path A: CLI argv through dispatch ──────────────────────────────────
    const createdA = await dispatch(root, ['world', 'create', '--example'], cli.ctx)
    const wA = (createdA.value as { worldId: string }).worldId
    await dispatch(root, ['author', 'state', 'add', wA, '--base', 'A cold cellar.', '--id', 'cellar'], cli.ctx)
    await dispatch(root, ['author', 'event', 'add', wA, '--from', 'lane', '--to', 'cellar', '--name', 'descend'], cli.ctx)
    await dispatch(root, ['author', 'state', 'update', wA, 'cellar', '--base', 'A flooded cellar.'], cli.ctx)
    await dispatch(root, ['author', 'ops', wA, '--ops', JSON.stringify([{ op: 'update_state', id: 'cellar', patch: { base: 'A dry cellar.' } }])], cli.ctx)

    // ── Path B: structured input through the bridge ────────────────────────
    const createdB = await runTool(root, 'world.create', { example: true }, app.ctx)
    const wB = createdB.ok ? (createdB.value as { worldId: string }).worldId : ''
    await runTool(root, 'author.state.add', { world: wB, base: 'A cold cellar.', id: 'cellar' }, app.ctx)
    await runTool(root, 'author.event.add', { world: wB, from: 'lane', to: 'cellar', name: 'descend' }, app.ctx)
    await runTool(root, 'author.state.update', { world: wB, id: 'cellar', base: 'A flooded cellar.' }, app.ctx)
    await runTool(root, 'author.ops', { world: wB, ops: [{ op: 'update_state', id: 'cellar', patch: { base: 'A dry cellar.' } }] }, app.ctx)

    // ── Read both graphs back and compare ──────────────────────────────────
    const readA = await dispatch(root, ['world', 'get', wA], cli.ctx)
    const readB = await runTool(root, 'world.get', { id: wB }, app.ctx)
    const sceneA = (readA.value as { scene: Scene }).scene
    const sceneB = (readB.ok ? (readB.value as { scene: Scene }).scene : { states: {}, events: [] })

    assert.deepEqual(sceneA.states, sceneB.states, 'the states are identical across the two authoring paths')
    assert.deepEqual(sceneA.events, sceneB.events, 'so are the events')
    // And the batch op really took effect through both paths.
    assert.equal((sceneA.states['cellar'] as { base: string }).base, 'A dry cellar.')
  } finally {
    rmSync(cli.dir, { recursive: true, force: true })
    rmSync(app.dir, { recursive: true, force: true })
  }
})
