/**
 * The filesystem seam, pinned from both sides.
 *
 * `world.import` can read a bundle from a path, but the tool tree must not name
 * `node:fs` — the same tree is bundled into the browser, and a static Node import
 * would break the build (and, if it somehow didn't, would be a lie: there is no
 * filesystem in a tab). So the capability is INJECTED: the CLI hands the tree a
 * `readTextFile`, the app does not, and the one leaf that wants it degrades
 * honestly when it is absent.
 *
 * Two things are load-bearing and tested here: with the seam a `--file` import
 * works; without it the same call fails IN PROSE rather than throwing an obscure
 * error, and the `--bundle` path (structured JSON, no disk) works regardless. The
 * build itself is the third proof — that no `node:` import reaches the bundle —
 * and it runs in CI, not here.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { LocalWorldStore } from '../../src/world/store/local'
import { fileStore, defaultStorePath } from '../../src/world/store/file.node'
import { runTool } from '../../src/tool/run'
import { root } from '../../src/tool/root'
import type { ToolContext } from '../../src/tool/define'

/** A ctx WITHOUT the seam — the app's shape. */
function appCtx(dir: string): ToolContext {
  const store = new LocalWorldStore(fileStore(defaultStorePath({ STUDIO_HOME: dir })))
  return { store, origin: 'app', json: false }
}

/** A ctx WITH the seam injected — the CLI's shape. */
function cliCtx(dir: string): ToolContext {
  return { ...appCtx(dir), readTextFile: (p) => readFile(p, 'utf8') }
}

test('a --file import works when the CLI injects readTextFile, and fails in prose when it is not', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'studio-seam-'))
  try {
    const app = appCtx(dir)
    // Seed a world and export it to a bundle on disk.
    await runTool(root, 'world.create', { example: true }, app)
    const exported = await runTool(root, 'world.export', {}, app)
    assert.equal(exported.ok, true)
    const bundlePath = join(dir, 'bundle.json')
    writeFileSync(bundlePath, JSON.stringify(exported.ok ? exported.value : {}), 'utf8')

    // Without the seam, reading a path is impossible and must be SAID, not thrown.
    const denied = await runTool(root, 'world.import', { file: bundlePath }, app)
    assert.equal(denied.ok, false)
    if (!denied.ok) assert.match(denied.error.message, /filesystem|--bundle/i)

    // With the seam, the same call reads the file and imports it.
    const allowed = await runTool(root, 'world.import', { file: bundlePath }, cliCtx(dir))
    assert.equal(allowed.ok, true)
    if (allowed.ok) {
      const res = allowed.value as { imported: unknown[] }
      assert.ok(res.imported.length >= 1, 'the bundle read from disk actually landed')
    }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('the --bundle path needs no filesystem: structured JSON imports with no seam', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'studio-seam-'))
  try {
    const app = appCtx(dir)
    await runTool(root, 'world.create', { example: true }, app)
    const exported = await runTool(root, 'world.export', {}, app)
    const bundle = exported.ok ? exported.value : {}

    // No readTextFile in this ctx; the bundle is handed over directly.
    const imported = await runTool(root, 'world.import', { bundle }, app)
    assert.equal(imported.ok, true, 'the browser path imports without ever touching a disk')
    if (imported.ok) {
      const res = imported.value as { imported: unknown[] }
      assert.ok(res.imported.length >= 1)
    }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('neither --file nor --bundle is a clear error, not a silent no-op', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'studio-seam-'))
  try {
    const app = appCtx(dir)
    const empty = await runTool(root, 'world.import', {}, app)
    assert.equal(empty.ok, false)
    if (!empty.ok) assert.match(empty.error.message, /--file|--bundle/i)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
