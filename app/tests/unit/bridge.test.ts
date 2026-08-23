/**
 * The in-process bridge: the app's door into the same tool tree the CLI walks.
 *
 * `runTool` and `dispatch` end at the same coerce-then-run, so what the terminal
 * can do the app can do. But the bridge answers to a PROGRAM, not a person: it
 * folds every result into one envelope, it never throws, and — unlike dispatch's
 * forgiving-on-reads recovery — it never guesses at a mistyped path. A typo in
 * code is a bug to surface, not a courtesy to paper over.
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
  const dir = mkdtempSync(join(tmpdir(), 'studio-bridge-'))
  const store = new LocalWorldStore(fileStore(defaultStorePath({ STUDIO_HOME: dir })))
  return { ctx: { store, origin: 'app', json: false }, dir }
}

test('a successful write returns an ok envelope with the new rev and diagnostics lifted out', async () => {
  const { ctx, dir } = freshCtx()
  try {
    const created = await runTool(root, 'world.create', { example: true }, ctx)
    assert.equal(created.ok, true)
    assert.equal(created.kind, 'mutation')
    const worldId = created.ok ? (created.value as { worldId: string }).worldId : ''
    assert.match(worldId, /^w_/)

    const wrote = await runTool(root, 'author.state.add', { world: worldId, base: 'A dim hallway.', id: 'hall' }, ctx)
    assert.equal(wrote.ok, true)
    if (wrote.ok) {
      assert.equal(typeof wrote.rev, 'string', 'the new rev is lifted onto the envelope')
      assert.ok(Array.isArray(wrote.diagnostics), 'diagnostics are always a list')
    }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('a read carries no rev, and its value is the store shape untouched', async () => {
  const { ctx, dir } = freshCtx()
  try {
    const created = await runTool(root, 'world.create', { example: true }, ctx)
    const worldId = created.ok ? (created.value as { worldId: string }).worldId : ''
    const read = await runTool(root, 'world.get', { id: worldId }, ctx)
    assert.equal(read.ok, true)
    if (read.ok) {
      assert.equal(read.kind, 'query')
      assert.equal(read.rev, undefined, 'a read lifts no rev')
      assert.ok((read.value as { scene: unknown }).scene, 'the store shape is passed through, not laundered')
    }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('a failing call folds into an error envelope instead of throwing', async () => {
  const { ctx, dir } = freshCtx()
  try {
    const missing = await runTool(root, 'world.get', { id: 'w_nope' }, ctx)
    assert.equal(missing.ok, false)
    if (!missing.ok) {
      assert.equal(missing.kind, 'query')
      assert.ok(missing.error.status >= 400, 'a real status is carried')
      assert.equal(typeof missing.error.message, 'string')
      assert.equal(missing.error.conflict, false)
    }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('an unknown path is a 404 envelope with a suggestion — never a thrown error', async () => {
  const { ctx, dir } = freshCtx()
  try {
    const bad = await runTool(root, 'world.creat', { example: true }, ctx)
    assert.equal(bad.ok, false)
    if (!bad.ok) {
      assert.equal(bad.kind, 'unknown')
      assert.equal(bad.error.status, 404)
      assert.match(bad.error.message, /world\.create/)
    }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('the bridge never auto-runs a mistyped mutation the way the CLI forgives a read', async () => {
  const { ctx, dir } = freshCtx()
  try {
    const before = await runTool(root, 'world.list', {}, ctx)
    const worldsBefore = before.ok ? (before.value as { worlds: unknown[] }).worlds.length : -1

    const typo = await runTool(root, 'world.creat', { example: true }, ctx)
    assert.equal(typo.ok, false, 'a mistyped mutation path does not execute')

    const after = await runTool(root, 'world.list', {}, ctx)
    const worldsAfter = after.ok ? (after.value as { worlds: unknown[] }).worlds.length : -2
    assert.equal(worldsAfter, worldsBefore, 'nothing was created by the near-miss')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('a bad parameter is a validation failure in the envelope, not an exception', async () => {
  const { ctx, dir } = freshCtx()
  try {
    const noId = await runTool(root, 'world.get', {}, ctx)
    assert.equal(noId.ok, false, 'a missing required param fails closed')

    const badEnum = await runTool(root, 'world.create', { example: true, nonsense: 1 }, ctx)
    assert.equal(badEnum.ok, false, 'an undeclared option is a typo, not an extension point')
    if (!badEnum.ok) assert.equal(badEnum.error.status, 400)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
