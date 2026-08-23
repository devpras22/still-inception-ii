/**
 * A campaign a REAL model wrote, walked by the runtime that consumes it.
 *
 * `tests/fixtures/live-book-campaign.json` is not hand-written. It is the exact
 * output of `runBookToCampaign` against Cerebras (`zai-glm-4.7`) on the chapter
 * in `evidence/live-chapter/chapter.txt` — 5 acts, 5 worlds, 72 seconds.
 * It is committed because three defects in this path survived a green stub suite
 * and fell out of the first live call: worlds keyed by the wrong id, edges with
 * an exit state no model could know, and a dead end reported as nothing at all.
 *
 * A stub fixture is written by someone who already knows the answer. This one
 * was not, so it keeps finding things.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { handoffFor, exitStatesFor, goldenIndex } from '../../src/world/campaign'
import type { Campaign } from '../../src/world'

const live: Campaign = JSON.parse(
  readFileSync(join(import.meta.dirname, '..', 'fixtures', 'live-book-campaign.json'), 'utf8'),
).campaign

test('a machine-written campaign walks from its start to the end of the golden thread', () => {
  const graph = live.graph
  let actId = graph.start
  // The walk CARRIES, because the player does. The first version of this test
  // passed `flags: []` at every hop and stopped one act short — correctly, as it
  // turned out: the act_2 → act_3 edge `requiresFlag: ledger_retrieved`, which
  // act_1 hands forward. A walk with no memory cannot open a door that needs it,
  // so threading the flags is what makes this a test of the gate and not of a
  // graph that happens to be linear.
  let flags: readonly string[] = []
  const path = [actId]

  for (let hop = 0; hop < 12; hop++) {
    const exits = [...exitStatesFor(graph, actId)]
    if (!exits.length) break
    const next = exits.map((s) => handoffFor({ graph, actId, stateId: s, flags })).find((h) => h?.kind === 'hop')
    if (!next || next.kind !== 'hop') break
    actId = next.toActId
    flags = next.flags
    path.push(actId)
  }

  const last = graph.goldenThread[graph.goldenThread.length - 1]
  assert.equal(path[path.length - 1], last, `the walk reached the end of the golden thread (got ${path.join(' → ')})`)
  assert.ok(path.length >= 3, 'and it took more than one hop to get there')
  assert.equal(goldenIndex(graph, path[path.length - 1]!), graph.goldenThread.length - 1)
})

test('every act on the golden thread offers an exit the runtime can resolve', () => {
  const graph = live.graph
  // The last act ends the story, so it is exempt — every earlier one is not.
  // Every flag any edge hands forward — the most generous player possible. An
  // act whose only way out is gated is still a legitimate act; an act with NO
  // way out for anyone is the dead thread this checks for.
  const everyFlag = graph.edges.flatMap((e) => e.carryFlags ?? [])
  for (const actId of graph.goldenThread.slice(0, -1)) {
    const exits = [...exitStatesFor(graph, actId)]
    assert.ok(exits.length > 0, `act "${actId}" has an exit state`)
    const resolved = exits.some((s) => handoffFor({ graph, actId, stateId: s, flags: everyFlag })?.kind === 'hop')
    assert.ok(resolved, `act "${actId}" hands off to somewhere`)
  }
})

// Flags are the only thing that crosses between acts, and for a while no
// authored campaign had any: the prompt never offered the fields and the parser
// dropped them. This fixture is the first live campaign that carries memory —
// act_1 hands `ledger_retrieved` forward and the next edge is GATED on it.
test('the player carries memory between acts, and an edge is gated on it', () => {
  const graph = live.graph
  const carrying = graph.edges.filter((e) => (e.carryFlags ?? []).length > 0)
  assert.ok(carrying.length > 0, 'the model authored at least one edge that hands a flag forward')
  const gated = graph.edges.filter((e) => e.requiresFlag)
  assert.ok(gated.length > 0, 'and at least one edge that is only offered to a player holding one')

  // The gate must be reachable: some earlier edge has to hand forward the very
  // flag it asks for, or it is a door with no key anywhere in the campaign.
  for (const g of gated) {
    const supplied = graph.edges.some((e) => (e.carryFlags ?? []).includes(g.requiresFlag!))
    assert.ok(supplied, `the flag "${g.requiresFlag}" is handed forward by some edge`)
  }

  // And it survives the runtime: walking the first hop leaves the player holding
  // exactly what the edge named — the rule is carry-only-what-is-named.
  const first = graph.edges.find((e) => (e.carryFlags ?? []).length > 0)!
  const out = handoffFor({ graph, actId: first.from.actId, stateId: first.from.state, flags: [] })
  assert.ok(out?.kind === 'hop')
  assert.deepEqual(out.flags, first.carryFlags, 'the named memory, and only that, travels')
})

test('the dead end the model authored is reachable and reported as one', () => {
  const graph = live.graph
  const terminal = graph.edges.filter((e) => !e.to)
  // CONDITIONAL on purpose. Whether a given campaign contains a dead end is up
  // to what the model wrote that day — the fixture was replaced with a run that
  // authored a loop instead, and an unconditional count would have failed for a
  // campaign that is perfectly well formed. The MECHANISM (a `to: null` edge
  // must report as `dead-end` and never as plain `null`) is pinned
  // unconditionally in `campaign.test.ts`, on a graph built for it and proven to
  // bite. What this adds is that real model output is read the same way.
  for (const e of terminal) {
    const out = handoffFor({ graph, actId: e.from.actId, stateId: e.from.state, flags: [] })
    assert.equal(out?.kind, 'dead-end', `${e.from.actId}:${e.from.state} reports as a dead end`)
  }
})

// The loop, authored by a model and proven to terminate.
//
// This fixture is the first campaign a model has written with a real `loop`
// edge, and its shape is the mechanic working as designed:
//   act_1:drained_mud --deviation--> act_4      (carries `distracted`)
//   act_4:release     --loop------> act_1      (carries `focused`)
//   act_1:drained_mud --golden----> act_2      (REQUIRES `focused`)
// So a first-time player cannot walk the golden thread. They must take the
// detour, and the detour is what hands them the key. `loop-terminates` says
// this is legal; only a walk says it is TRUE.
test('the authored loop sends the player back and lets them leave a different way', () => {
  const graph = live.graph
  const loop = graph.edges.find((e) => e.kind === 'loop')
  assert.ok(loop, 'the model authored a loop edge')

  const hop = (actId: string, flags: readonly string[]) => {
    for (const s of exitStatesFor(graph, actId)) {
      const h = handoffFor({ graph, actId, stateId: s, flags })
      if (h?.kind === 'hop') return h
    }
    return null
  }

  // First visit: no memory, so the gated golden edge is not on offer.
  const first = hop(graph.start, [])
  assert.ok(first, 'act_1 hands off somewhere on a first visit')
  assert.equal(first.edge.kind, 'deviation', 'and with no flags it is the detour, not the spine')

  // The detour hands back the key.
  const back = hop(first.toActId, first.flags)
  assert.ok(back, 'the detour act hands off')
  assert.equal(back.edge.kind, 'loop', 'by looping')
  assert.equal(back.toActId, graph.start, 'back to where the player came from')
  assert.ok(back.flags.includes('focused'), `carrying the key it grants (got ${JSON.stringify(back.flags)})`)

  // SECOND visit to the same act, same exit state, DIFFERENT way out. This is
  // the whole point of a loop, and the one thing a lint cannot check.
  const second = hop(graph.start, back.flags)
  assert.ok(second, 'the second visit hands off too')
  assert.equal(second.edge.kind, 'golden', 'and now the spine is open')
  assert.notEqual(second.toActId, first.toActId, 'a different act than the first visit led to')

  // And it converges: from there the thread runs to its end without repeating.
  const seen = [graph.start, first.toActId, graph.start, second.toActId]
  let at = second.toActId
  let flags: readonly string[] = second.flags
  for (let i = 0; i < 6; i++) {
    const h = hop(at, flags)
    if (!h) break
    at = h.toActId; flags = h.flags; seen.push(at)
  }
  assert.equal(at, graph.goldenThread[graph.goldenThread.length - 1], `the walk ends the book (${seen.join(' → ')})`)
})
