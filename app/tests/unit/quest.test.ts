/**
 * A quest from a frame, pinned against stubs.
 *
 * The rule this pipeline exists to enforce is one sentence long — never build
 * an action on an object the detector cannot find — and it is the rule a
 * language model breaks the moment you stop watching, because "the ancient
 * mechanism" is a much better quest step than "the door". So the tests that
 * matter here are the REFUSALS: what happens when nothing verified, and what
 * happens when the model grounds on a noun that was never seen.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { LocalWorldStore } from '../../src/world/store/local'
import { fileStore, defaultStorePath } from '../../src/world/store/file.node'
import { runQuestGeneration, QuestError } from '../../src/author/agent/quest'
import type { LLMProvider, LLMRequest, ImageProvider, VisionProvider, DetectedBox } from '../../src/provider/types'

function stubLLM(replies: string[]): LLMProvider & { seen: LLMRequest[] } {
  const seen: LLMRequest[] = []
  return {
    id: 'stub', label: 'stub', seen,
    isConfigured: () => true,
    async complete(req: LLMRequest): Promise<string> {
      seen.push(req)
      return replies[seen.length - 1] ?? replies[replies.length - 1] ?? ''
    },
  }
}

function stubImage(): ImageProvider {
  return { id: 'i', label: 'i', isConfigured: () => true, async generate() { return { b64: 'AAAA', mime: 'image/png' } } }
}

function stubVision(hits: string[]): VisionProvider {
  const box: DetectedBox = { xMin: 0.2, yMin: 0.2, xMax: 0.6, yMax: 0.6 }
  return {
    id: 'v', label: 'v', isConfigured: () => true,
    async detect(_b64: string, object: string): Promise<DetectedBox[]> {
      return hits.includes(object) ? [box] : []
    },
  }
}

const CANDIDATES = JSON.stringify({ objects: [{ object: 'steel door', variants: ['steel door', 'metal door'] }] })

const GOOD = JSON.stringify({
  name: 'The Delivery',
  reply: 'Three steps, one of them a mistake.',
  mission: {
    id: 'drop', title: 'The Drop',
    objectives: [
      { id: 'reach', text: 'Reach the steel door', action: 'The courier crosses the wet alley until the door fills the frame.', grounded: { target: 'steel door' } },
      { id: 'leave', text: 'Leave the package', action: 'The package goes down against the foot of the door.', outcome: 'The package sits alone at the door in the rain.', fail: { name: 'Knock', action: 'A gloved fist strikes the metal twice.', outcome: 'Light spills into the alley.', title: 'SEEN' } },
    ],
  },
})

async function fresh(): Promise<{ store: LocalWorldStore; id: string; dir: string }> {
  const dir = mkdtempSync(join(tmpdir(), 'studio-quest-'))
  const store = new LocalWorldStore(fileStore(defaultStorePath({ STUDIO_HOME: dir })))
  const created = await store.createWorld({ premise: 'a courier in a wet alley' }, 'test')
  return { store, id: created.worldId ?? '', dir }
}

test('a verified frame yields a mission that COMPILED into the graph', async () => {
  const { store, id, dir } = await fresh()
  try {
    const res = await runQuestGeneration({
      llm: stubLLM([CANDIDATES, GOOD]), store, image: stubImage(), vision: stubVision(['steel door', 'metal door']),
      worldId: id, premise: 'a courier in a wet alley',
    })
    assert.equal(res.objectives, 2)
    assert.deepEqual(res.verified, ['steel door'])

    const scene = await store.getScene(id)
    // Two objectives + one fail branch = three events, chained by flags.
    assert.deepEqual(scene.events.map((e) => e.name), ['Reach the steel door', 'Leave the package', 'Knock'])
    assert.deepEqual(scene.events[1]?.requires, ['reach'])
    assert.equal(scene.events[0]?.anchor?.label, 'steel door', 'grounded on what the probe SAW')
    const doc = await store.getWorld(id)
    assert.equal((doc.world ?? doc).missions?.[0]?.id, 'drop', 'and the quest record landed too')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('an objective grounded on a noun nobody saw comes BACK as a correction', async () => {
  const { store, id, dir } = await fresh()
  try {
    const ungrounded = JSON.stringify({
      name: 'x', reply: 'y',
      mission: { id: 'drop', title: 'The Drop', objectives: [
        { id: 'reach', text: 'Turn the ancient mechanism', action: 'It grinds around.', grounded: { target: 'ancient mechanism' } },
      ] },
    })
    const llm = stubLLM([CANDIDATES, ungrounded, GOOD])
    const res = await runQuestGeneration({
      llm, store, image: stubImage(), vision: stubVision(['steel door', 'metal door']),
      worldId: id, premise: 'a courier in a wet alley',
    })
    assert.equal(res.rounds, 2, 'it took a correction round')
    // The correction NAMED the offence and the allowed vocabulary — enforcement,
    // not a polite request.
    const correction = llm.seen[2]?.messages.at(-1)?.content ?? ''
    assert.match(correction, /did NOT find/)
    assert.match(correction, /ancient mechanism/)
    assert.match(correction, /steel door/)
    const scene = await store.getScene(id)
    assert.equal(scene.events[0]?.anchor?.label, 'steel door', 'what landed is grounded')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('nothing verified means NO quest — never a quest nobody can play', async () => {
  const { store, id, dir } = await fresh()
  try {
    await assert.rejects(
      () => runQuestGeneration({
        llm: stubLLM([CANDIDATES, GOOD]), store, image: stubImage(),
        vision: stubVision([]), // the detector finds nothing
        worldId: id, premise: 'a courier in a wet alley',
      }),
      (e: unknown) => e instanceof QuestError && /never take/.test(e.message),
    )
    // And it wrote NOTHING: a half-authored quest is worse than none.
    assert.equal((await store.getScene(id)).events.length, 0)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('no vision axis is a refusal with the reason, not a silent ungrounded quest', async () => {
  const { store, id, dir } = await fresh()
  try {
    await assert.rejects(
      () => runQuestGeneration({
        llm: stubLLM([CANDIDATES, GOOD]), store, image: stubImage(),
        worldId: id, premise: 'a courier in a wet alley',
      }),
      (e: unknown) => e instanceof QuestError && /vision provider is configured/.test(e.message),
    )
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('a mission that compiles into a doctrine-breaking world is sent back', async () => {
  const { store, id, dir } = await fresh()
  try {
    const negated = JSON.stringify({
      name: 'x', reply: 'y',
      mission: { id: 'drop', title: 'The Drop', objectives: [
        { id: 'reach', text: 'Reach the steel door', action: 'There is no light in the alley at all.', grounded: { target: 'steel door' } },
      ] },
    })
    const llm = stubLLM([CANDIDATES, negated, GOOD])
    const res = await runQuestGeneration({
      llm, store, image: stubImage(), vision: stubVision(['steel door', 'metal door']),
      worldId: id, premise: 'a courier in a wet alley',
    })
    assert.equal(res.rounds, 2)
    const correction = llm.seen[2]?.messages.at(-1)?.content ?? ''
    assert.match(correction, /doctrine rejects/)
    assert.match(correction, /negation/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
