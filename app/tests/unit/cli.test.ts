/**
 * The CLI against a real store on disk.
 *
 * The claim being tested is that the terminal and the browser run the SAME
 * store: one implementation of what a world is, one set of graph operations,
 * one validation path. A second implementation for the CLI would drift, and the
 * drift would show up as somebody's world being readable in one place and not
 * the other.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { LocalWorldStore } from '../../src/world/store/local'
import { fileStore, defaultStorePath } from '../../src/world/store/file.node'
import { dispatch } from '../../src/tool/dispatch'
import { runTool } from '../../src/tool/run'
import { root } from '../../src/tool/root'
import type { ToolContext } from '../../src/tool/define'

function freshCtx(): { ctx: ToolContext; dir: string } {
  const dir = mkdtempSync(join(tmpdir(), 'studio-cli-'))
  const store = new LocalWorldStore(fileStore(defaultStorePath({ STUDIO_HOME: dir })))
  return { ctx: { store, origin: 'cli', json: false }, dir }
}

test('a world authored through the CLI is a real world in the store', async () => {
  const { ctx, dir } = freshCtx()
  try {
    const created = await dispatch(root, ['world', 'create', '--example'], ctx)
    const worldId = (created.value as { worldId: string }).worldId
    assert.match(worldId, /^w_/)

    const listed = await dispatch(root, ['world', 'list'], ctx)
    assert.equal((listed.value as { worlds: unknown[] }).worlds.length, 1)

    await dispatch(root, ['author', 'state', 'add', worldId, '--base', 'Rain on the lane.', '--id', 'rain'], ctx)
    await dispatch(root, ['author', 'event', 'add', worldId, '--from', 'lane', '--to', 'rain', '--name', 'it_rains'], ctx)

    const read = await dispatch(root, ['world', 'get', worldId], ctx)
    const scene = (read.value as { scene: { states: Record<string, unknown>; events: { name: string }[] } }).scene
    assert.ok('rain' in scene.states, 'the state written by the CLI is in the graph')
    assert.ok(scene.events.some((e) => e.name === 'it_rains'), 'so is the event')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('the file store survives a process boundary — worlds are on disk, not in memory', async () => {
  const { ctx, dir } = freshCtx()
  try {
    const created = await dispatch(root, ['world', 'create', '--example'], ctx)
    const worldId = (created.value as { worldId: string }).worldId

    // A completely separate store instance over the same file: this is what the
    // next CLI invocation sees.
    const second: ToolContext = {
      store: new LocalWorldStore(fileStore(defaultStorePath({ STUDIO_HOME: dir }))),
      origin: 'cli',
      json: false,
    }
    const read = await dispatch(root, ['world', 'get', worldId], second)
    assert.ok((read.value as { world: unknown }).world, 'the world is readable from a fresh process')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('an export round-trips through import without duplicating anything', async () => {
  const { ctx, dir } = freshCtx()
  try {
    await dispatch(root, ['world', 'create', '--example'], ctx)
    const exported = await dispatch(root, ['world', 'export'], ctx)
    const bundle = exported.value as { worlds: unknown[] }
    assert.equal(bundle.worlds.length, 1)

    // Re-importing the same bundle must not destroy the local copy. The store
    // brings it in as a COPY under a new id rather than overwriting, which is
    // the safe default: a bundle is someone's backup, and silently replacing
    // newer local work with older backed-up work is the one outcome nobody
    // wants from a restore.
    const again = await ctx.store.importWorlds(bundle)
    const outcomes = again.imported.map((w) => w.as)
    assert.deepEqual(outcomes, ['copy'], 'a second import lands as a copy, never a replace')
    const after = await dispatch(root, ['world', 'list'], ctx)
    assert.equal((after.value as { worlds: unknown[] }).worlds.length, 2)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('a version round-trips: snapshot, edit, diff, and restore with an auto-backup', async () => {
  const { ctx, dir } = freshCtx()
  try {
    const created = await dispatch(root, ['world', 'create', '--example'], ctx)
    const w = (created.value as { worldId: string }).worldId

    // Freeze the starting graph, then change a state.
    const snap = await dispatch(root, ['world', 'version', 'snapshot', w, '--title', 'before'], ctx)
    const v1 = (snap.value as { versionId: string }).versionId
    assert.ok(v1, 'a snapshot has an id')

    const before = await dispatch(root, ['world', 'get', w], ctx)
    const laneBefore = (before.value as { scene: { states: Record<string, { base: string }> } }).scene.states['lane']!.base

    await dispatch(root, ['author', 'state', 'update', w, 'lane', '--base', 'A lane, utterly transformed.'], ctx)
    const v2snap = await dispatch(root, ['world', 'version', 'snapshot', w, '--title', 'after'], ctx)
    const v2 = (v2snap.value as { versionId: string }).versionId

    // The diff sees the state we changed.
    const diff = await dispatch(root, ['world', 'version', 'diff', w, v1, v2], ctx)
    const changed = (diff.value as { states: { changed: string[] } }).states.changed
    assert.ok(changed.includes('lane'), 'the diff names the state that changed')

    // Restore to v1. By default it snapshots the current graph first, so the
    // restore is itself undoable.
    const restored = await dispatch(root, ['world', 'version', 'restore', w, v1], ctx)
    const backupVersion = (restored.value as { backupVersion?: string }).backupVersion
    assert.ok(backupVersion, 'restore left a pre-restore backup behind')

    const after = await dispatch(root, ['world', 'get', w], ctx)
    const laneAfter = (after.value as { scene: { states: Record<string, { base: string }> } }).scene.states['lane']!.base
    assert.equal(laneAfter, laneBefore, 'the graph is back to the snapshotted prose')

    // Three versions now exist: before, after, and the pre-restore backup.
    const list = await dispatch(root, ['world', 'version', 'list', w], ctx)
    assert.ok((list.value as { versions: unknown[] }).versions.length >= 3)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('help is reachable for every node and never throws', async () => {
  const { ctx, dir } = freshCtx()
  try {
    for (const argv of [[], ['world'], ['world', '--help'], ['author', 'state', '--help'], ['world', 'list', '--help']]) {
      const res = await dispatch(root, argv, ctx)
      assert.equal(res.code, 0, `${argv.join(' ')} should render help cleanly`)
      assert.ok((res.output ?? '').length > 0, `${argv.join(' ')} produced no help`)
    }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('an unknown command fails, and a mutation typo is never executed', async () => {
  const { ctx, dir } = freshCtx()
  try {
    const bad = await dispatch(root, ['world', 'delet', 'w_nope'], ctx)
    assert.equal(bad.code, 1)
    assert.match(bad.output ?? '', /did you mean "world delete"/i)

    const nonsense = await dispatch(root, ['world', 'zzzzzz'], ctx)
    assert.equal(nonsense.code, 1)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('docs reads the studio\'s own domain map off its source, and refuses in prose without a filesystem', async () => {
  const { ctx, dir } = freshCtx()
  try {
    const withFs: ToolContext = { ...ctx, readTextFile: (p) => readFile(p, 'utf8') }
    const result = await dispatch(root, ['docs'], withFs)
    assert.equal(result.code, 0)
    const domains = (result.value as { domains: { name: string; contract: string }[] }).domains
    assert.deepEqual(
      domains.map((d) => d.name),
      ['account', 'author', 'play', 'provider', 'studio', 'theme', 'world', 'tool'],
    )
    for (const domain of domains) {
      assert.ok(domain.contract.length > 0, `${domain.name} has a non-empty contract`)
      if (domain.name !== 'tool') {
        assert.match(domain.contract, /Belongs here/, `${domain.name} states what belongs here`)
      }
    }

    // The app never injects `readTextFile` — the seam `world.import` also
    // relies on — so the same call fails in prose naming the CLI, not with an
    // opaque stack trace: `dispatch` does not catch a leaf's throw, and it is
    // the message a caller (the CLI's own top-level handler) prints verbatim.
    let threw: unknown
    try {
      await dispatch(root, ['docs'], ctx)
    } catch (e) {
      threw = e
    }
    assert.ok(threw instanceof Error, 'docs without a filesystem throws rather than silently failing')
    assert.match(threw.message, /CLI/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

// ─── The ops boundary: malformed fields are refused by name, not laundered ───

test('author.ops refuses add_state when "base" is not a string, and writes nothing', async () => {
  const { ctx, dir } = freshCtx()
  try {
    const created = await dispatch(root, ['world', 'create', '--example'], ctx)
    const worldId = (created.value as { worldId: string }).worldId

    const before = await dispatch(root, ['world', 'get', worldId], ctx)
    const statesBefore = Object.keys(
      (before.value as { scene: { states: Record<string, unknown> } }).scene.states,
    )

    const res = await runTool(
      root,
      'author.ops',
      { world: worldId, ops: [{ op: 'add_state', id: 'bad', base: 42 }] },
      ctx,
    )
    assert.equal(res.ok, false, 'a non-string base is refused')
    if (!res.ok) {
      assert.equal(res.error.status, 400)
      assert.match(res.error.message, /"base"/, 'the error names the bad field')
    }

    const after = await dispatch(root, ['world', 'get', worldId], ctx)
    const statesAfter = Object.keys(
      (after.value as { scene: { states: Record<string, unknown> } }).scene.states,
    )
    assert.deepEqual(statesAfter, statesBefore, 'nothing was written — the bad state never landed')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('author.ops refuses update_event when "to" is not a string, and writes nothing', async () => {
  const { ctx, dir } = freshCtx()
  try {
    const created = await dispatch(root, ['world', 'create', '--example'], ctx)
    const worldId = (created.value as { worldId: string }).worldId

    const before = await dispatch(root, ['world', 'get', worldId], ctx)
    const eventBefore = (before.value as { scene: { events: { name: string; to?: string }[] } }).scene.events.find(
      (e) => e.name === 'walk_up_the_lane',
    )

    const res = await runTool(
      root,
      'author.ops',
      { world: worldId, ops: [{ op: 'update_event', name: 'walk_up_the_lane', patch: { to: 42 } }] },
      ctx,
    )
    assert.equal(res.ok, false, 'a non-string "to" is refused')
    if (!res.ok) {
      assert.equal(res.error.status, 400)
      assert.match(res.error.message, /"to"/, 'the error names the bad field')
    }

    const after = await dispatch(root, ['world', 'get', worldId], ctx)
    const eventAfter = (after.value as { scene: { events: { name: string; to?: string }[] } }).scene.events.find(
      (e) => e.name === 'walk_up_the_lane',
    )
    assert.deepEqual(eventAfter, eventBefore, 'nothing was written — the event is untouched')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('a well-formed ops batch still applies, atomically, in one revision', async () => {
  const { ctx, dir } = freshCtx()
  try {
    const created = await dispatch(root, ['world', 'create', '--example'], ctx)
    const worldId = (created.value as { worldId: string }).worldId

    const res = await runTool(
      root,
      'author.ops',
      {
        world: worldId,
        ops: [
          { op: 'add_state', id: 'porch', base: 'A covered porch, rain on the roof.' },
          { op: 'add_event', kind: 'transition', from: 'lane', to: 'porch', name: 'to_porch' },
        ],
      },
      ctx,
    )
    assert.equal(res.ok, true, 'a well-formed batch still lands')

    const after = await dispatch(root, ['world', 'get', worldId], ctx)
    const scene = (after.value as { scene: { states: Record<string, unknown>; events: { name: string }[] } }).scene
    assert.ok('porch' in scene.states, 'the new state is in the graph')
    assert.ok(scene.events.some((e) => e.name === 'to_porch'), 'so is the new event')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('null cannot erase a required field: a state keeps its base, an event keeps its kind', async () => {
  const { ctx, dir } = freshCtx()
  try {
    const created = await dispatch(root, ['world', 'create', '--example'], ctx)
    const w = (created.value as { worldId: string }).worldId

    // null means ERASE in a patch — legal for optional fields, never for the
    // ones the graph cannot stand without. The refusal is a thrown StoreError
    // (the CLI renders it at its top level), so it is asserted as a rejection.
    await assert.rejects(
      dispatch(root, ['author', 'ops', w, '--ops', JSON.stringify([{ op: 'update_state', id: 'lane', patch: { base: null } }])], ctx),
      /base.*cannot be erased/i,
    )
    await assert.rejects(
      dispatch(root, ['author', 'ops', w, '--ops', JSON.stringify([{ op: 'update_event', name: 'walk_up_the_lane', patch: { kind: null } }])], ctx),
      /kind.*cannot be erased/i,
    )

    // And neither refusal wrote anything.
    const read = await dispatch(root, ['world', 'get', w], ctx)
    const scene = (read.value as { scene: { states: Record<string, { base: string }>; events: { name: string; kind: string }[] } }).scene
    assert.ok(scene.states['lane']!.base.length > 0)
    assert.ok(scene.events.find((e) => e.name === 'walk_up_the_lane')!.kind)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('the typo-correction notice survives a failing corrected run', async () => {
  const { ctx, dir } = freshCtx()
  try {
    // "world gett" corrects to the query "world get", which then 404s. The
    // agent must still learn its command was rewritten — otherwise it retries
    // the typo, not the fix.
    const res = await dispatch(root, ['world', 'gett', 'w_nope'], ctx)
    assert.equal(res.code, 1)
    assert.match(res.output ?? '', /interpreting as "world get"/)
    assert.match(res.output ?? '', /No world/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
