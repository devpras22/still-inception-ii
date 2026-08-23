/**
 * A book laid out as a macro-graph.
 *
 * `author chapter` makes one world from one chapter. A book is not more
 * chapters — it is the shape between them, the spine. The engine that PLAYS
 * such a graph already existed; nothing could write one from prose until now.
 *
 * What is worth testing is the repair, not the call: a model that names an act
 * in an edge and forgets to define it produces a campaign whose lints fail when
 * the player opens it, which is the worst possible place to find out.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'

import { spineFromBook, toBeats, toBible, SpineError, MIN_ACTS } from '../../src/author/agent/spine'
import type { LLMProvider, LLMRequest } from '../../src/provider/types'

const stub = (reply: string): LLMProvider & { seen: LLMRequest[] } => {
  const seen: LLMRequest[] = []
  return { id: 'stub', label: 'stub', seen, isConfigured: () => true, async complete(r: LLMRequest) { seen.push(r); return reply } }
}
const BEATS = [
  { title: 'She arrives', summary: 'She crosses the footbridge.' },
  { title: 'She finds it', summary: 'She finds the ledger.' },
]
const BIBLE = { logline: 'A woman returns to the lock.', protagonist: 'a woman in a coat', characters: [], locations: ['Footbridge — rotting planks'], style: 'grey light' }

const spine = (over: Record<string, unknown> = {}) => JSON.stringify({
  title: 'The Lock-Keeper',
  logline: 'A woman returns to the lock.',
  acts: [
    { actId: 'act_1', title: 'The bridge', canonical: true, summary: 'She crosses.', setting: 'A rotting footbridge', goal: 'Reach the cottage' },
    { actId: 'act_2', title: 'The ledger', canonical: true, summary: 'She reads it.', setting: 'A cold front room', goal: 'Learn what happened' },
  ],
  goldenThread: ['act_1', 'act_2'],
  edges: [{ from: 'act_1', to: 'act_2', kind: 'golden', label: 'she crosses' }],
  ...over,
})

test('an edge naming an act nobody defined is dropped, not passed on', async () => {
  // Left in, this reaches `resolveEdge` as a hand-off to a world that does not
  // exist, and the campaign lints refuse to open at play time.
  const s = await spineFromBook(stub(spine({
    edges: [
      { from: 'act_1', to: 'act_2', kind: 'golden' },
      { from: 'act_1', to: 'act_99', kind: 'deviation' },
      { from: 'ghost', to: 'act_2', kind: 'golden' },
    ],
  })), BEATS, BIBLE)
  assert.equal(s.edges.length, 1, `only the resolvable edge survived: ${JSON.stringify(s.edges)}`)
  assert.equal(s.edges[0]?.to?.actId, 'act_2')
})

test('an unknown edge kind falls back to golden rather than reaching the runtime', async () => {
  // The first draft of this prompt taught the model "advance/branch/end" — words
  // the engine has no branch for. The typechecker caught that; this catches a
  // model inventing its own.
  const s = await spineFromBook(stub(spine({ edges: [{ from: 'act_1', to: 'act_2', kind: 'advance' }] })), BEATS, BIBLE)
  assert.equal(s.edges[0]?.kind, 'golden')
})

test('a dead end is an edge to nothing, and survives', async () => {
  const s = await spineFromBook(stub(spine({ edges: [{ from: 'act_2', to: null, kind: 'deviation' }] })), BEATS, BIBLE)
  assert.equal(s.edges.length, 1)
  assert.equal(s.edges[0]?.to, null)
})

test('one act is a chapter, and is refused as one', async () => {
  await assert.rejects(
    () => spineFromBook(stub(spine({ acts: [{ actId: 'act_1', title: 'Only', canonical: true, summary: 'x', setting: 'y', goal: 'z' }] })), BEATS, BIBLE),
    (e: Error) => e instanceof SpineError && /at least 2/.test(e.message) && /author chapter/.test(e.message),
  )
  assert.equal(MIN_ACTS, 2)
})

test('a golden thread that lost acts falls back to the canonical order', async () => {
  // A thread naming an act that was filtered away claims a faithful reading
  // which skips part of the book — worse than having no thread at all.
  const s = await spineFromBook(stub(spine({ goldenThread: ['act_1', 'nope'] })), BEATS, BIBLE)
  assert.deepEqual(s.goldenThread, ['act_1', 'act_2'])
})

test('the blobs a terminal hands in are narrowed, not trusted', () => {
  assert.throws(() => toBeats('not an array'), SpineError)
  assert.throws(() => toBeats([{ title: 'no summary' }]), SpineError)
  assert.throws(() => toBible({ characters: [] }), SpineError)
  assert.deepEqual(toBeats([{ title: 'a', summary: 'b' }, { summary: 'c' }]), [{ title: 'a', summary: 'b' }, { title: '', summary: 'c' }])
  assert.equal(toBible({ logline: 'x' }).logline, 'x')
})

// Flags are the player's memory across acts, and for a while they were a
// capability no author could reach: the prompt's JSON shape never offered
// `carryFlags`/`requiresFlag`, and this parser dropped them if a model sent
// them anyway. A live run confirmed it — every hop reported `flags []`, and the
// `loop-terminates` lint refused the campaign the model wrote.
test('the flags an edge carries survive the parser', async () => {
  const s = await spineFromBook(stub(spine({
    edges: [
      { from: 'act_1', to: 'act_2', kind: 'golden', label: 'she crosses', carryFlags: ['saw_the_line'] },
      { from: 'act_2', to: 'act_1', kind: 'loop', label: 'she goes back', carryFlags: ['has_key'] },
      { from: 'act_1', to: 'act_2', kind: 'deviation', label: 'the other door', requiresFlag: 'has_key' },
    ],
  })), BEATS, BIBLE, 2)

  assert.deepEqual(s.edges[0]?.carryFlags, ['saw_the_line'], 'a golden edge hands its flag forward')
  assert.deepEqual(s.edges[1]?.carryFlags, ['has_key'], 'the loop carries what makes the second visit different')
  assert.equal(s.edges[2]?.requiresFlag, 'has_key', 'and an edge can be gated on holding it')
})

test('the prompt offers the flag vocabulary it expects back', async () => {
  const llm = stub(spine())
  await spineFromBook(llm, BEATS, BIBLE, 2)
  const system = llm.seen[0]?.messages.find((m) => m.role === 'system')?.content ?? ''
  // A field the model is never shown is a field it will never send. This is the
  // cheapest possible guard against the prompt and the parser drifting apart.
  assert.match(system, /carryFlags/, 'the shape names carryFlags')
  assert.match(system, /requiresFlag/, 'the shape names requiresFlag')
  assert.match(system, /loop.*MUST carry a flag/s, 'and states the loop obligation the lint enforces')
})
