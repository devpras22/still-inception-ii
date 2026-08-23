/**
 * A book becomes a campaign — the assembly, and what it refuses.
 *
 * The pieces existed apart: `chapter.ts` reads prose, `spine.ts` lays out acts,
 * `world/campaign.ts` plays the macro-graph and lints it. What is
 * worth testing here is not that they can be called in order. It is the two
 * decisions the assembly makes on its own: that a failed act stops the run
 * rather than saving a story with a hole in it, and that the six lints run while
 * the AUTHOR is still watching rather than when a player presses Play.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { runBookToCampaign, briefForAct, BookError } from '../../src/author/agent/book'
import { LocalWorldStore } from '../../src/world/store/local'
import { fileStore, defaultStorePath } from '../../src/world/store/file.node'
import { runTool, root } from '../../src/tool'
import type { LLMProvider, LLMRequest } from '../../src/provider/types'

/** Replies in order: segment, bible, spine, then a graph for every act. */
function scripted(replies: string[]): LLMProvider & { calls: number } {
  let i = 0
  return {
    id: 'stub', label: 'stub', calls: 0,
    isConfigured: () => true,
    async complete(_r: LLMRequest): Promise<string> {
      const out = replies[Math.min(i, replies.length - 1)] ?? ''
      i += 1
      ;(this as unknown as { calls: number }).calls = i
      return out
    },
  }
}

const SEGMENT = JSON.stringify({ protagonist: 'a woman in a coat', beats: [
  { title: 'She arrives', summary: 'She crosses the footbridge.' },
  { title: 'She reads', summary: 'She finds the ledger.' },
] })
const BIBLE = JSON.stringify({ logline: 'A woman returns to the lock.', protagonist: 'a woman in a coat', characters: [], locations: ['Footbridge — rotting planks'], style: 'grey light' })
const SPINE = JSON.stringify({
  title: 'The Lock-Keeper', logline: 'A woman returns to the lock.',
  acts: [
    { actId: 'act_1', title: 'The bridge', canonical: true, summary: 'She crosses.', setting: 'A rotting footbridge', goal: 'Reach the cottage' },
    { actId: 'act_2', title: 'The ledger', canonical: true, summary: 'She reads it.', setting: 'A cold front room', goal: 'Learn what happened' },
  ],
  goldenThread: ['act_1', 'act_2'],
  edges: [{ from: 'act_1', to: 'act_2', kind: 'golden' }],
})
// A world the kernel's own bar accepts: `verifyWorld` wants five to eight
// states, a real branch, and a way to win AND lose. The first draft of this
// fixture had two states, scored 33/100, and the kernel correctly asked for a
// correction — which a scripted stub cannot give. Raise the fixture to the
// promise; never lower the gate to the fixture.
const shot = (what: string) =>
  `A third-person rear-view shot of a woman in a coat on ${what}, grey afternoon light, ` +
  `rust and damp on every surface, the canal running flat and brown behind her.`
const GRAPH = JSON.stringify({ reply: 'Built it.', name: 'Act', ops: [
  { op: 'add_state', id: 'bridge', base: shot('the rotting planks of a footbridge'), camera: { static: 'eye level, behind her', dynamic: 'a slow push forward' }, movement: { static: 'she grips the rail', dynamic: 'she edges across' }, ambient: ['water dripping through the gaps'] },
  { op: 'add_state', id: 'bank', base: shot('the far bank among wet nettles'), camera: { static: 'low, looking up the path', dynamic: 'a slow rise' }, movement: { static: 'she stands still', dynamic: 'she walks up the path' }, ambient: ['a leaf skittering'] },
  { op: 'add_state', id: 'cottage', base: shot('the step of a low grey cottage'), camera: { static: 'wide on the door', dynamic: 'a slow drift left' }, movement: { static: 'she waits', dynamic: 'she reaches for the latch' }, ambient: ['a loose gutter ticking'] },
  { op: 'add_state', id: 'inside', base: shot('the cold front room, a dresser against the wall'), camera: { static: 'from the doorway', dynamic: 'a slow walk in' }, movement: { static: 'she stands in her coat', dynamic: 'she crosses to the dresser' }, ambient: ['soot settling'] },
  { op: 'add_state', id: 'water', base: shot('the black water below the bridge'), camera: { static: 'looking down', dynamic: 'a slow fall' }, movement: { static: 'she is under', dynamic: 'the current takes her' }, ambient: ['bubbles going up'] },
  { op: 'add_transition', from: 'bridge', to: 'bank', name: 'cross_the_bridge', base: 'She puts her weight on the last plank and steps off onto the bank.' },
  { op: 'add_transition', from: 'bridge', to: 'water', name: 'slip_and_fall', base: 'The plank gives and she goes through into the canal.' },
  { op: 'add_transition', from: 'bank', to: 'cottage', name: 'walk_up', base: 'She walks up the nettled path to the door.' },
  { op: 'add_state', id: 'shed', base: shot('a leaning shed behind the cottage'), camera: { static: 'wide on the door', dynamic: 'a slow drift' }, movement: { static: 'she peers in', dynamic: 'she pushes the door' }, ambient: ['a hinge complaining'] },
  { op: 'add_transition', from: 'bank', to: 'shed', name: 'go_round_the_back', base: 'She follows the wall round to a leaning shed.' },
  { op: 'add_transition', from: 'shed', to: 'cottage', name: 'come_back_round', base: 'She comes back round to the front step, the key in her fist.' },
  { op: 'set_event_grants', event: 'go_round_the_back', grants: ['has_key'] },
  { op: 'add_transition', from: 'cottage', to: 'inside', name: 'go_inside', base: 'The latch lifts and she steps into the cold.' },
  { op: 'set_event_requires', event: 'go_inside', requires: ['has_key'] },
  { op: 'set_event_locked_hint', event: 'go_inside', hint: 'The door is locked. There was always a key round the back.' },
  { op: 'add_override', from: 'inside', name: 'read_the_ledger', detail: 'She turns the ledger to the light and reads the pencilled line again.' },
  { op: 'set_state_ending', state: 'inside', kind: 'win', title: 'The ledger', subtitle: 'She is where she meant to be.' },
  { op: 'set_state_ending', state: 'water', kind: 'lose', title: 'The current', subtitle: 'The canal keeps what it takes.' },
  { op: 'set_entrance', state: 'bridge' },
  // The store seeds every new world with an `opening` stub. Move the entrance
  // off it and it is orphaned, which `verifyWorld` calls unreachable and refuses
  // — the first draft of this fixture scored 84/100 for exactly that. A real
  // model has to clear it too, so the fixture models the real obligation.
  { op: 'remove_state', id: 'opening' },
] })

async function fresh() {
  const dir = mkdtempSync(join(tmpdir(), 'studio-book-'))
  const store = new LocalWorldStore(fileStore(defaultStorePath({ STUDIO_HOME: dir })))
  const tools = { run: (p: string, i: Record<string, unknown>, o?: { origin?: 'app' | 'agent' }) =>
    runTool(root, p, i, { store, origin: o?.origin ?? 'agent', json: false }) }
  return { store, tools, dir }
}

test('too short to be a book is refused, and pointed at the chapter path', async () => {
  const { store, tools, dir } = await fresh()
  try {
    await assert.rejects(
      () => runBookToCampaign({ llm: scripted([SEGMENT]), store, tools, text: 'x'.repeat(900) }),
      (e: Error) => e instanceof BookError && /author chapter/.test(e.message),
    )
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('every act becomes a real world, and the campaign is saved with the lints run', async () => {
  const { store, tools, dir } = await fresh()
  try {
    const res = await runBookToCampaign({
      llm: scripted([SEGMENT, BIBLE, SPINE, GRAPH, GRAPH]),
      store, tools, text: 'y'.repeat(2000),
    })
    assert.equal(res.worlds.length, 2, 'one world per act')
    // Each act gets its OWN world. This missed once: `createWorld`'s second
    // argument is an idempotency key, a constant was passed for every act, and
    // the store handed act 2 the world act 1 had already authored. The test
    // that caught it only did so because the kernel then refused duplicate
    // state ids — a coincidence. Assert the property directly.
    assert.equal(new Set(res.worlds.map((w) => w.worldId)).size, res.worlds.length, 'no two acts share a world')
    // The campaign is only worth saving if its acts point at worlds the store
    // can actually open — that is the one failure the macro engine cannot fix.
    for (const a of res.campaign.graph.acts) {
      const w = await store.getWorld(a.worldId)
      assert.ok(Object.keys(w.scene.states).length > 0, `${a.actId} points at a real world`)
    }
    // The lints must come back CLEAN on a campaign this path just built. Without
    // this the suite only proved lintCampaign was CALLED, and a live run showed
    // it returning `act "act_1" has no world` for four worlds that existed.
    assert.deepEqual(res.diagnostics.filter((d) => d.severity === 'error'), [], 'the campaign it built passes its own lints')
    assert.equal(res.campaign.graph.start, 'act_1', 'the story starts at the top of the golden thread')
    const stored = await store.getCampaign(res.campaign.id)
    assert.equal(stored.graph.acts.length, 2, 'it was persisted, not just returned')
    assert.ok(Array.isArray(res.diagnostics), 'the six lints ran while the author was still here')
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('a failed act stops the run instead of saving a story with a hole in it', async () => {
  const { store, tools, dir } = await fresh()
  try {
    // The second act's author returns nothing usable. A campaign saved anyway
    // would be a story that ends in a wall, and the lints refuse it at PLAY
    // time — long after the author stopped watching.
    await assert.rejects(() => runBookToCampaign({
      llm: scripted([SEGMENT, BIBLE, SPINE, GRAPH, 'not json at all', 'not json at all', 'not json at all', 'not json at all']),
      store, tools, text: 'y'.repeat(2000),
    }))
    const { campaigns } = await store.listCampaigns()
    assert.equal(campaigns.length, 0, 'nothing was saved')
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('a non-canonical act is briefed as a real alternative, not a mistake', () => {
  const spine = { title: 'T', logline: 'L', acts: [], edges: [], goldenThread: [] }
  const road = briefForAct({ actId: 'a', title: 'The other way', canonical: false, summary: 's', setting: 'p', goal: 'g' }, spine)
  assert.match(road, /road the book did NOT take/)
  assert.match(road, /real alternative, not a mistake/)
  const taken = briefForAct({ actId: 'b', title: 'The way', canonical: true, summary: 's', setting: 'p', goal: 'g' }, spine)
  assert.match(taken, /the book's own path/)
})

// The kernel's progress must reach the caller, attributed to its act.
// A book takes minutes; printing four lines and going quiet while each act
// paints, probes and self-corrects is the same pipeline lying about its state.
test('what the kernel is doing inside each act is reported, and says which act', async () => {
  const { store, tools, dir } = await fresh()
  try {
    const notes: string[] = []
    const res = await runBookToCampaign({
      llm: scripted([SEGMENT, BIBLE, SPINE, GRAPH, GRAPH]),
      store, tools, text: 'y'.repeat(2000),
      progress: (n) => notes.push(n),
    })
    const acts = res.spine.acts.map((a) => a.title)
    const inner = notes.filter((n) => acts.some((t) => n.startsWith(`${t}: `)))
    assert.ok(inner.length > 0, `the kernel's own notes are forwarded (saw: ${JSON.stringify(notes)})`)
    // And attribution is the point: with two acts authoring, an unlabelled
    // "Authoring the world…" tells the reader nothing about which one.
    assert.ok(new Set(inner.map((n) => n.slice(0, n.indexOf(':')))).size >= 1)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
