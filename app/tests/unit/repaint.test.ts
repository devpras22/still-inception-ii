/**
 * Repainting the opening frame of a world that already exists.
 *
 * The seed was paintable at CREATE and nowhere else, so a world whose opening
 * prose had been rewritten kept a picture of the premise it started life as.
 * That matters more than it sounds: the seed is the frame the world model
 * continues FROM and the frame the anchor probe grounds against.
 *
 * The behaviour worth pinning is WHERE THE PROMPT COMES FROM — the entrance
 * state's own prose, not the premise. A repaint that used the premise again
 * would be a button that redraws the same picture.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { LocalWorldStore } from '../../src/world/store/local'
import { fileStore, defaultStorePath } from '../../src/world/store/file.node'
import { repaintEntrance, GenerationError } from '../../src/author/agent/generate'
import { runTool, root } from '../../src/tool'
import type { ImageProvider } from '../../src/provider/types'
import { unwrapWorldDoc } from '../../src/world'

function stubImage(overrides: Partial<ImageProvider> = {}): ImageProvider & { asked: string[] } {
  const asked: string[] = []
  return {
    id: 'stub-image',
    label: 'stub image',
    asked,
    isConfigured: () => true,
    async generate(prompt: string) {
      asked.push(prompt)
      return { b64: 'PAINTED', mime: 'image/png' }
    },
    ...overrides,
  } as ImageProvider & { asked: string[] }
}

async function fresh() {
  const dir = mkdtempSync(join(tmpdir(), 'studio-repaint-'))
  const store = new LocalWorldStore(fileStore(defaultStorePath({ STUDIO_HOME: dir })))
  const created = await store.createWorld({ template: 'starter' }, 'k')
  const tools = {
    run: (path: string, input: Record<string, unknown>, opts?: { origin?: 'app' | 'agent' }) =>
      runTool(root, path, input, { store, origin: opts?.origin ?? 'app', json: false }),
  }
  return { store, tools, id: created.worldId ?? '', dir }
}

test('the repaint prompt is the ENTRANCE PROSE, and the new frame lands on the world', async () => {
  const { store, tools, id, dir } = await fresh()
  try {
    // Rewrite the opening — the case this whole feature exists for.
    const rev = (await store.getScene(id)).rev
    await store.applyOps(id, [
      { op: 'update_state', id: 'lane', patch: { base: 'A rear-view shot of a walker on a rutted lane under heavy snow.', camera: { static: 'low, the ruts filling', dynamic: 'low, following' } } },
    ], rev)

    const image = stubImage()
    const res = await repaintEntrance({ image, store, tools, worldId: id })

    assert.equal(image.asked.length, 1)
    assert.match(image.asked[0] ?? '', /heavy snow/, 'painted from the prose as it is NOW')
    assert.match(image.asked[0] ?? '', /the ruts filling/, 'and the parked camera came with it')
    assert.doesNotMatch(image.asked[0] ?? '', /premise/i)

    const world = unwrapWorldDoc(await store.getWorld(id))
    assert.equal(world.entrance?.image?.src, 'data:image/png;base64,PAINTED')
    assert.equal(world.entrance?.state, 'lane', 'and repainting did not move the entrance')
    assert.match(res.prompt, /heavy snow/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('with no image model it says so, and changes nothing', async () => {
  const { store, tools, id, dir } = await fresh()
  try {
    const before = unwrapWorldDoc(await store.getWorld(id)).entrance?.image?.src
    await assert.rejects(
      () => repaintEntrance({ image: stubImage({ isConfigured: () => false }), store, tools, worldId: id }),
      (e: unknown) => e instanceof GenerationError && /No image model is configured/.test(e.message),
    )
    assert.equal(unwrapWorldDoc(await store.getWorld(id)).entrance?.image?.src, before)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('a provider that refuses is reported in its own words, and the old frame stays', async () => {
  const { store, tools, id, dir } = await fresh()
  try {
    const angry = stubImage({ generate: async () => { throw new Error('quota exhausted') } })
    await assert.rejects(
      () => repaintEntrance({ image: angry, store, tools, worldId: id }),
      (e: unknown) => e instanceof GenerationError && /quota exhausted/.test(e.message),
    )
    assert.equal(unwrapWorldDoc(await store.getWorld(id)).entrance?.image?.src, undefined)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
