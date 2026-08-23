/**
 * The macro-graph: several worlds joined into one story.
 *
 * The rules are not obvious, and each case below is there for a failure
 * somebody hit: the golden edge wins so the faithful path is the default; a flag-gated edge
 * outranks an ungated one so a memory loop can leave a DIFFERENT way the second
 * time; and `loop-terminates` is the load-bearing lint — a loop that hands back
 * no flag its target can gate on is an infinite loop a player discovers only by
 * living it.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  campaignHasErrors,
  carryFlagsThrough,
  exitStatesFor,
  goldenIndex,
  goldenThreadReaches,
  handoffFor,
  campaignFinished,
  lintCampaign,
  reachableActs,
  resolveEdge,
} from '../../src/world/campaign'
import type { CampaignGraph } from '../../src/world/campaign'
import type { SMWorld } from '../../src/world/api'
import { LocalWorldStore } from '../../src/world/store/local'
import { fileStore, defaultStorePath } from '../../src/world/store/file.node'

function world(states: Record<string, { ending?: { kind: 'win' | 'lose'; title: string } }>, id?: string): SMWorld {
  return {
    ...(id ? { id } : {}),
    entrance: { state: Object.keys(states)[0] ?? '' },
    scene: {
      states: Object.fromEntries(
        Object.entries(states).map(([k, v]) => [k, { base: `A rear-view shot of a diver in ${k}.`, ...v }]),
      ),
      events: [],
    },
  } as unknown as SMWorld
}

/** Two acts on a spine, plus a branch that recombines. */
function graph(): CampaignGraph {
  return {
    start: 'act_1',
    goldenThread: ['act_1', 'act_2'],
    acts: [
      { actId: 'act_1', worldId: 'w_one', title: 'The Gate', canonical: true },
      { actId: 'act_2', worldId: 'w_two', title: 'The Vault', canonical: true },
    ],
    edges: [
      { from: { actId: 'act_1', state: 'departure' }, to: { actId: 'act_2' }, kind: 'golden', carryFlags: ['has_key'] },
    ],
  }
}

const WORLDS = (): Record<string, SMWorld> => ({
  act_1: world({ gate: {}, departure: {} }, 'w_one'),
  act_2: world({ hall: {}, crowned: { ending: { kind: 'win', title: 'Crowned' } } }, 'w_two'),
})

test('a clean campaign lints clean, and the spine is walkable', () => {
  const diags = lintCampaign(graph(), WORLDS())
  assert.deepEqual(diags, [], JSON.stringify(diags))
  assert.equal(goldenThreadReaches(graph(), WORLDS()).ok, true)
  assert.deepEqual([...reachableActs(graph())].sort(), ['act_1', 'act_2'])
  assert.deepEqual([...exitStatesFor(graph(), 'act_1')], ['departure'])
  assert.equal(goldenIndex(graph(), 'act_2'), 1)
  assert.equal(goldenIndex(graph(), 'act_9'), -1, 'off the spine')
})

test('the GOLDEN edge wins — the faithful path is the default attractor', () => {
  const g = graph()
  g.edges.push({ from: { actId: 'act_1', state: 'departure' }, to: { actId: 'act_2' }, kind: 'deviation' })
  assert.equal(resolveEdge(g, 'act_1', 'departure')?.kind, 'golden')
})

test('a flag-GATED edge outranks an ungated one, which is how a loop escapes', () => {
  const g = graph()
  g.acts.push({ actId: 'act_0', worldId: 'w_zero', title: 'The Village', canonical: false })
  g.edges.push(
    { from: { actId: 'act_0', state: 'square' }, to: { actId: 'act_1' }, kind: 'deviation' },
    { from: { actId: 'act_0', state: 'square' }, to: { actId: 'act_2' }, kind: 'recombine', requiresFlag: 'remembers' },
  )
  // First pass: no memory, so the ungated edge is all there is.
  assert.equal(resolveEdge(g, 'act_0', 'square', [])?.to?.actId, 'act_1')
  // Second pass, carrying the memory: the gated edge is preferred, so the
  // player leaves the loop a different way.
  assert.equal(resolveEdge(g, 'act_0', 'square', ['remembers'])?.to?.actId, 'act_2')
})

test('a state with no edge is terminal', () => {
  assert.equal(resolveEdge(graph(), 'act_1', 'gate'), null)
})

test('an edge carries only the memory it names', () => {
  const edge = { from: { actId: 'a', state: 's' }, to: { actId: 'b' }, kind: 'golden' as const, carryFlags: ['has_key'] }
  assert.deepEqual(carryFlagsThrough(edge, ['has_key', 'saw_the_ghost', 'ate_lunch']), ['has_key'])
  // …and what it names is handed forward even if the player never held it: the
  // edge is the author's statement about what the next act may assume.
  assert.deepEqual(carryFlagsThrough(edge, []), ['has_key'])
  assert.deepEqual(carryFlagsThrough({ ...edge, carryFlags: undefined }, ['has_key']), [])
})

test('LOOP-TERMINATES: a loop that carries no usable flag is an infinite loop', () => {
  const g = graph()
  g.acts.push({ actId: 'act_0', worldId: 'w_zero', title: 'The Village', canonical: false })
  g.edges.push(
    { from: { actId: 'act_1', state: 'gate' }, to: { actId: 'act_0' }, kind: 'loop', carryFlags: ['went_back'] },
    { from: { actId: 'act_0', state: 'square' }, to: { actId: 'act_1' }, kind: 'deviation' },
  )
  const worlds = { ...WORLDS(), act_0: world({ square: {} }, 'w_zero') }

  const diags = lintCampaign(g, worlds)
  assert.ok(campaignHasErrors(diags))
  const loop = diags.find((d) => d.rule === 'loop-terminates')
  assert.match(loop?.message ?? '', /can never progress/)
  assert.equal(loop?.actId, 'act_0')

  // Give act_0 an exit gated on the flag the loop carries, and it is a story.
  g.edges.push({ from: { actId: 'act_0', state: 'square' }, to: { actId: 'act_2' }, kind: 'recombine', requiresFlag: 'went_back' })
  assert.equal(lintCampaign(g, worlds).filter((d) => d.rule === 'loop-terminates').length, 0)
})

test('the structural lints catch each way the chain breaks', () => {
  const dangling = graph()
  dangling.edges[0] = { ...dangling.edges[0]!, to: { actId: 'act_nowhere' } }
  assert.ok(lintCampaign(dangling, WORLDS()).some((d) => d.rule === 'dangling-edge'))

  const badExit = graph()
  badExit.edges[0] = { ...badExit.edges[0]!, from: { actId: 'act_1', state: 'a_state_that_is_not_there' } }
  assert.ok(lintCampaign(badExit, WORLDS()).some((d) => d.rule === 'exit-state-exists'))

  const orphan = graph()
  orphan.acts.push({ actId: 'act_lost', worldId: 'w_lost', title: 'Nowhere', canonical: false })
  const withLost = { ...WORLDS(), act_lost: world({ nowhere: {} }, 'w_lost') }
  assert.ok(lintCampaign(orphan, withLost).some((d) => d.rule === 'unreachable-act'))

  const noWorld = graph()
  const missing = WORLDS()
  delete missing['act_2']
  assert.ok(lintCampaign(noWorld, missing).some((d) => d.rule === 'act-has-world'))

  // The spine has to END somewhere a player can win.
  const noWin = graph()
  const loseOnly = { ...WORLDS(), act_2: world({ hall: {}, dead: { ending: { kind: 'lose' as const, title: 'Lost' } } }, 'w_two') }
  assert.ok(lintCampaign(noWin, loseOnly).some((d) => d.rule === 'golden-thread'))
})

test('the HAND-OFF never fires on the act\'s own entrance', () => {
  // This guard exists because a spine sometimes hangs a macro edge
  // on the entrance ("refuse to leave"), which would bounce the player out of
  // the chapter on boot and skip it whole.
  const g = graph()
  g.edges.push({ from: { actId: 'act_1', state: 'gate' }, to: { actId: 'act_2' }, kind: 'deviation' })
  assert.equal(handoffFor({ graph: g, actId: 'act_1', stateId: 'gate', entranceState: 'gate', flags: [] }), null)
  // Any other state hands off normally.
  const hop = handoffFor({ graph: g, actId: 'act_1', stateId: 'departure', entranceState: 'gate', flags: ['has_key', 'junk'] })
  assert.equal(hop?.kind, 'hop')
  assert.ok(hop?.kind === 'hop')
  assert.equal(hop.toActId, 'act_2')
  assert.deepEqual(hop.flags, ['has_key'], 'and only the named memory travels')
})

// A dead end is an authored outcome — `to: null` means terminal failure, and a
// live model wrote one ("The key is lost"). It used to come back as plain
// `null`, indistinguishable from "nothing happens here", so the player stood in
// a state the author had ENDED and was never told.
test('a dead-end edge is reported as a dead end, not as no edge at all', () => {
  const g = graph()
  g.edges.push({ from: { actId: 'act_1', state: 'lost' }, to: null, kind: 'golden', label: 'The key is lost' })
  const out = handoffFor({ graph: g, actId: 'act_1', stateId: 'lost', flags: [] })
  assert.equal(out?.kind, 'dead-end', 'the terminal edge is surfaced')
  assert.ok(out?.kind === 'dead-end')
  assert.equal(out.edge.label, 'The key is lost', 'carrying the label the player should read')
  // A state with no edge at all is still plain null — the two must not merge.
  assert.equal(handoffFor({ graph: g, actId: 'act_1', stateId: 'nowhere', flags: [] }), null)
})

test('the store keeps campaigns beside worlds, and refuses an act with no world', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'studio-campaign-'))
  try {
    const store = new LocalWorldStore(fileStore(defaultStorePath({ STUDIO_HOME: dir })))
    const one = await store.createWorld({ premise: 'the gate' }, 'k1')
    const two = await store.createWorld({ premise: 'the vault' }, 'k2')

    await assert.rejects(
      () => store.saveCampaign({
        id: 'c_1', title: 'The Book',
        graph: { start: 'act_1', goldenThread: ['act_1'], acts: [{ actId: 'act_1', worldId: 'w_nope', title: 'Ghost', canonical: true }], edges: [] },
      }),
      /points at a world this store does not have/,
    )

    const saved = await store.saveCampaign({
      id: 'c_1', title: 'The Book',
      graph: {
        start: 'act_1',
        goldenThread: ['act_1', 'act_2'],
        acts: [
          { actId: 'act_1', worldId: one.worldId ?? '', title: 'The Gate', canonical: true },
          { actId: 'act_2', worldId: two.worldId ?? '', title: 'The Vault', canonical: true },
        ],
        edges: [{ from: { actId: 'act_1', state: 'opening' }, to: { actId: 'act_2' }, kind: 'golden', carryFlags: [] }],
      },
    })
    assert.ok(saved.created_at)
    assert.equal((await store.listCampaigns()).campaigns.length, 1)
    assert.equal((await store.getCampaign('c_1')).title, 'The Book')

    // The lints run over the acts' CURRENT worlds — a starter world has no win
    // ending, so the golden thread is reported broken rather than assumed fine.
    const verdict = await store.lintCampaign('c_1')
    assert.equal(verdict.ok, false)
    assert.ok(verdict.diagnostics.some((d) => d.rule === 'golden-thread'))

    await store.deleteCampaign('c_1')
    assert.equal((await store.listCampaigns()).campaigns.length, 0)
    await assert.rejects(() => store.getCampaign('c_1'), /No such campaign/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('deleting a world SAYS which stories it broke, and the campaign then refuses to play', async () => {
  // The rot this guards against, in the campaign's own shape: an act pointing at a world
  // that was valid when the act was written. `saveCampaign` checks at write
  // time — which is exactly the check that cannot see this coming.
  const dir = mkdtempSync(join(tmpdir(), 'studio-camp-rot-'))
  try {
    const store = new LocalWorldStore(fileStore(defaultStorePath({ STUDIO_HOME: dir })))
    const one = await store.createWorld({ template: 'starter' }, 'k1')
    const two = await store.createWorld({ template: 'starter' }, 'k2')
    await store.saveCampaign({
      id: 'c_rot', title: 'Two Fields',
      graph: {
        start: 'act_1',
        goldenThread: ['act_1', 'act_2'],
        acts: [
          { actId: 'act_1', worldId: one.worldId ?? '', title: 'One', canonical: true },
          { actId: 'act_2', worldId: two.worldId ?? '', title: 'Two', canonical: true },
        ],
        edges: [{ from: { actId: 'act_1', state: 'bench_under_trees' }, to: { actId: 'act_2' }, kind: 'golden', carryFlags: [] }],
      },
    })

    const res = await store.deleteWorld(two.worldId ?? '')
    assert.deepEqual(res.brokeCampaigns, ['Two Fields'], 'the delete said what it cost')

    // The act is STILL THERE — reported, not repaired — and the lints now
    // refuse the campaign rather than letting a player walk into the hole.
    const campaign = await store.getCampaign('c_rot')
    assert.equal(campaign.graph.acts.length, 2)
    const verdict = await store.lintCampaign('c_rot')
    assert.equal(verdict.ok, false)
    assert.ok(verdict.diagnostics.some((d) => d.rule === 'act-has-world' && d.actId === 'act_2'))
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('deleting a world no story uses says nothing extra', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'studio-camp-quiet-'))
  try {
    const store = new LocalWorldStore(fileStore(defaultStorePath({ STUDIO_HOME: dir })))
    const solo = await store.createWorld({ template: 'starter' }, 'k')
    const res = await store.deleteWorld(solo.worldId ?? '')
    assert.equal(res.brokeCampaigns, undefined, 'no noise where there is no cost')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

// Finishing an ACT and finishing the BOOK are different sizes of event.
//
// `handoffFor` learned to report a terminal failure as a dead end, and
// its opposite went unnamed: a player who reached the end of the story saw the
// same state-level "YOU WIN" as someone who finished act one. Watched happening
// — act_3 rendered as "act 3 of 3" with no notion of what finishing it meant.
// The rule: a state the macro-graph does not lead out of, whose
// ending is a win, ends the campaign.
test('a terminal win ends the book, and an act with a way out does not', () => {
  const g = graph()
  g.edges.push({ from: { actId: 'act_1', state: 'gate' }, to: { actId: 'act_2' }, kind: 'golden' })

  // act_2 has no outgoing edge, so its win is the end of the story.
  assert.equal(campaignFinished(g, 'act_2', 'finale', 'win'), true)

  // The same win inside an act the graph LEADS OUT OF is just an act ending —
  // the story continues, and saying "that is the end" there would be a lie.
  assert.equal(campaignFinished(g, 'act_1', 'gate', 'win'), false)

  // A loss is never the end of the book: a terminal lose routes to the
  // dead-end rewind, which is a different affordance entirely.
  assert.equal(campaignFinished(g, 'act_2', 'finale', 'lose'), false)
  assert.equal(campaignFinished(g, 'act_2', 'finale', undefined), false)

  // It is NOT "the last act on the golden thread": any terminal win ends the
  // run, which is what lets a deviation be a real alternative ending.
  assert.ok(!g.goldenThread.includes('act_9'))
  assert.equal(campaignFinished(g, 'act_9', 'somewhere', 'win'), true)
})
