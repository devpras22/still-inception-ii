/**
 * The kernel agent, pinned against a stub model.
 *
 * No network here: every test hands `runGeneration` a canned reply and checks
 * what it does with it. The behaviours worth pinning are the ones that protect
 * an author's world — an unparseable answer must change nothing, a doctrine
 * failure must come back to the model as its own errors, and an empty
 * "correction" must never be mistaken for success.
 *
 * The one thing these cannot pin is whether a REAL model writes a good world;
 * that is what the manual probe in tests/probe is for, and its result belongs
 * in a commit message, not in an assertion.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { LocalWorldStore } from '../../src/world/store/local'
import { fileStore, defaultStorePath } from '../../src/world/store/file.node'
import { runGeneration, GenerationError } from '../../src/author/agent/generate'
import type { LLMProvider, LLMRequest, ImageProvider, VisionProvider, DetectedBox } from '../../src/provider/types'

/** A model that reads from a script, and records what it was asked. */
function stubLLM(replies: string[]): LLMProvider & { seen: LLMRequest[] } {
  const seen: LLMRequest[] = []
  return {
    id: 'stub',
    label: 'stub',
    seen,
    isConfigured: () => true,
    async complete(req: LLMRequest): Promise<string> {
      seen.push(req)
      return replies[seen.length - 1] ?? replies[replies.length - 1] ?? ''
    },
  }
}

/** A configured image provider that paints a fixed pixel — enough for
 *  paintFirstFrame to succeed deterministically, with no real network. */
function stubImage(): ImageProvider {
  return {
    id: 'stub-image',
    label: 'stub image',
    isConfigured: () => true,
    async generate(): Promise<{ b64: string; mime: string }> {
      return { b64: 'AAAA', mime: 'image/png' }
    },
  }
}

/** A vision provider that "hits" on exactly the labels in `hitLabels` and
 *  records every object it was asked to detect, in order. */
function stubVision(hitLabels: string[]): VisionProvider & { asked: string[] } {
  const asked: string[] = []
  const box: DetectedBox = { xMin: 0.1, yMin: 0.1, xMax: 0.5, yMax: 0.5 }
  return {
    id: 'stub-vision',
    label: 'stub vision',
    asked,
    isConfigured: () => true,
    async detect(_imageB64: string, object: string): Promise<DetectedBox[]> {
      asked.push(object)
      return hitLabels.includes(object) ? [box] : []
    },
  }
}

async function fresh(): Promise<{ store: LocalWorldStore; id: string; dir: string }> {
  const dir = mkdtempSync(join(tmpdir(), 'studio-gen-'))
  const store = new LocalWorldStore(fileStore(defaultStorePath({ STUDIO_HOME: dir })))
  const created = await store.createWorld({ premise: 'a beaver exploring Atlantis' }, 'test')
  return { store, id: created.worldId ?? '', dir }
}

/** A minimal world the doctrine accepts: entrance, a branch, both endings. */
const GOOD_OPS = JSON.stringify({
  reply: 'Built the sunken city.',
  ops: [
    { op: 'update_state', id: 'opening', patch: { base: 'A rear-view shot of a beaver at the gates of a sunken city, columns rising in the green water.' } },
    { op: 'add_state', id: 'plaza', base: 'A rear-view shot of a beaver in a drowned plaza, statues leaning in the current.' },
    { op: 'add_state', id: 'throne', base: 'A rear-view shot of a beaver before a coral throne, light falling through the dome.' },
    { op: 'add_state', id: 'abyss', base: 'A rear-view shot of a beaver over a black trench, the water going cold and empty.' },
    { op: 'set_entrance', state: 'opening' },
    { op: 'add_state', id: 'gate', base: 'A rear-view shot of a beaver at a coral gate, the city glowing beyond the bars.' },
    { op: 'add_event', name: 'swim_in', kind: 'transition', from: ['opening'], to: 'plaza' },
    { op: 'add_event', name: 'listen', kind: 'override', from: ['opening'], detail: 'The water hums with a low, old sound.' },
    { op: 'add_event', name: 'climb_throne', kind: 'transition', from: ['plaza'], to: 'throne' },
    { op: 'add_event', name: 'dive_deep', kind: 'transition', from: ['plaza'], to: 'abyss' },
    { op: 'add_event', name: 'to_gate', kind: 'transition', from: ['plaza'], to: 'gate' },
    { op: 'add_event', name: 'back_to_plaza', kind: 'transition', from: ['gate'], to: 'plaza' },
    { op: 'update_state', id: 'throne', patch: { ending: { kind: 'win', title: 'Crowned', subtitle: 'The city wakes.' } } },
    { op: 'update_state', id: 'abyss', patch: { ending: { kind: 'lose', title: 'Lost', subtitle: 'The trench keeps him.' } } },
  ],
})

test('a good reply authors a whole graph: entrance, a branch, endings', async () => {
  const { store, id, dir } = await fresh()
  try {
    const res = await runGeneration({ llm: stubLLM([GOOD_OPS]), store, worldId: id, premise: 'a beaver exploring Atlantis' })
    assert.equal(res.rounds, 1)
    assert.equal(res.states, 5)
    assert.equal(res.events, 6)
    assert.deepEqual(res.diagnostics, [], 'a clean world reports no doctrine diagnostics')

    const scene = await store.getScene(id)
    assert.ok(scene.events.some((e) => e.name === 'dive_deep'), 'the branch landed')
    assert.equal(scene.states['throne']?.ending?.kind, 'win')
    assert.equal(scene.states['abyss']?.ending?.kind, 'lose')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('an unparseable reply changes nothing, and the model is asked again', async () => {
  const { store, id, dir } = await fresh()
  try {
    const before = await store.getScene(id)
    const llm = stubLLM(['I would love to help!', 'still not json', 'nope', 'nope'])
    await assert.rejects(
      runGeneration({ llm, store, worldId: id, premise: 'x' }),
      (e: unknown) => e instanceof GenerationError,
    )
    const after = await store.getScene(id)
    assert.deepEqual(Object.keys(after.states), Object.keys(before.states), 'no state was written')
    assert.equal(after.events.length, before.events.length)
    assert.equal(llm.seen.length, 4, 'it pressed for all four rounds rather than giving up on the first')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('a doctrine failure comes back to the model as its own errors, and the fix lands', async () => {
  const { store, id, dir } = await fresh()
  try {
    // Round one writes prose carrying a negation — the doctrine rejects it.
    const bad = JSON.stringify({
      reply: 'first try',
      ops: [
        { op: 'update_state', id: 'opening', patch: { base: 'A beaver at the gates. There are no fish here.' } },
        { op: 'set_entrance', state: 'opening' },
      ],
    })
    // The fix also has to leave a world worth playing behind it: the shape the
    // prompt asks for is part of the contract now, so a correction that fixes
    // the prose and authors nothing is still a failure.
    const fix = JSON.stringify({
      reply: 'fixed',
      // The fix has to leave a world that keeps the prompt's promises, because
      // `verifyWorld` now judges the RESULT and not just the prose that failed.
      ops: [
        { op: 'update_state', id: 'opening', patch: { base: 'A rear-view shot of a beaver at the gates of a sunken city, columns rising in the still green water.' } },
        { op: 'add_state', id: 'plaza', base: 'A rear-view shot of a beaver in a drowned plaza, statues leaning in the current.' },
        { op: 'add_state', id: 'vault', base: 'A rear-view shot of a beaver before a sealed vault, gold light along its seams.' },
        { op: 'add_state', id: 'throne', base: 'A rear-view shot of a beaver on a coral throne as the city wakes around it.' },
        { op: 'add_state', id: 'abyss', base: 'A rear-view shot of a beaver over a black trench, the water going cold and empty.' },
        { op: 'update_state', id: 'throne', patch: { ending: { kind: 'win', title: 'Crowned' } } },
        { op: 'update_state', id: 'abyss', patch: { ending: { kind: 'lose', title: 'Lost' } } },
        { op: 'add_event', name: 'swim_in', kind: 'transition', from: ['opening'], to: 'plaza' },
        { op: 'add_event', name: 'to_vault', kind: 'transition', from: ['plaza'], to: 'vault' },
        { op: 'add_event', name: 'dive_deep', kind: 'transition', from: ['plaza'], to: 'abyss' },
        { op: 'add_event', name: 'open_vault', kind: 'transition', from: ['vault'], to: 'throne' },
        { op: 'add_event', name: 'retreat', kind: 'transition', from: ['vault'], to: 'plaza' },
        { op: 'add_event', name: 'listen', kind: 'override', from: ['opening'], detail: 'The water hums with a low, old sound.' },
      ],
    })
    const llm = stubLLM([bad, fix])
    const res = await runGeneration({ llm, store, worldId: id, premise: 'x' })
    assert.equal(res.rounds, 2, 'it took a correction round')
    assert.equal(llm.seen.length, 2)

    const corrective = llm.seen[1]?.messages.at(-1)?.content ?? ''
    assert.match(corrective, /negation/, 'the corrective turn names the lint that failed')
    assert.match(corrective, /states\.opening\.base/, 'and the field it failed on')

    const scene = await store.getScene(id)
    assert.doesNotMatch(scene.states['opening']?.base ?? '', /no fish/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('the ask gate returns a question and applies nothing', async () => {
  const { store, id, dir } = await fresh()
  try {
    const asking = JSON.stringify({
      reply: 'I need one thing first.',
      question: 'Is the beaver exploring a ruin, or a city still lived in?',
      ops: [{ op: 'add_state', id: 'ignored', base: 'this must not be written' }],
    })
    const res = await runGeneration({ llm: stubLLM([asking]), store, worldId: id, premise: 'x' })
    assert.match(res.question ?? '', /ruin/)
    const scene = await store.getScene(id)
    assert.ok(!('ignored' in scene.states), 'ops that arrive alongside a question are not applied')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('an empty second round is refused as a retreat, not accepted as success', async () => {
  const { store, id, dir } = await fresh()
  try {
    const bad = JSON.stringify({
      reply: 'first try',
      ops: [{ op: 'update_state', id: 'opening', patch: { base: 'Nothing is here.' } }, { op: 'set_entrance', state: 'opening' }],
    })
    const empty = JSON.stringify({ reply: 'ok I give up', ops: [] })
    const llm = stubLLM([bad, empty, empty, empty])
    await assert.rejects(
      runGeneration({ llm, store, worldId: id, premise: 'x' }),
      // The message now reports the TRAIL of what actually ended each round —
      // it used to say "the doctrine accepts" even when the doctrine had never
      // run, which sent a measurement run after the wrong rule.
      (e: unknown) => e instanceof GenerationError && /gave up after 4 rounds/.test(e.message) && /no ops/.test(e.message),
    )
    assert.equal(llm.seen.length, 4, 'an empty answer never ends the loop early')
    const last = llm.seen[3]?.messages.at(-1)?.content ?? ''
    assert.match(last, /empty/i, 'and it is told an empty edit authors nothing')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('the probe drops what the vision model misses: only the verified label reaches the author', async () => {
  const { store, id, dir } = await fresh()
  try {
    // Call 1 is the candidate-noun proposal; call 2 is the actual authoring
    // turn — stubLLM serves them in that order.
    const candidateReply = JSON.stringify({ objects: ['door', 'artifact'] })
    const llm = stubLLM([candidateReply, GOOD_OPS])
    const vision = stubVision(['door'])

    const res = await runGeneration({
      llm,
      store,
      worldId: id,
      premise: 'a beaver exploring Atlantis',
      image: stubImage(),
      vision,
    })

    assert.deepEqual(vision.asked.sort(), ['artifact', 'door'], 'both candidates were actually probed')
    assert.deepEqual(
      res.probed.map((p) => p.label).sort(),
      ['artifact', 'door'],
      'the report names every candidate, hit or miss',
    )
    assert.ok((res.probed.find((p) => p.label === 'door')?.hits ?? 0) > 0, 'door was detected')
    assert.equal(res.probed.find((p) => p.label === 'artifact')?.hits, 0, 'artifact was probed and missed')

    const authoringTurn = llm.seen[1]?.messages.at(-1)?.content ?? ''
    assert.match(authoringTurn, /\bdoor\b/, 'the verified label is offered to the author')
    assert.doesNotMatch(authoringTurn, /\bartifact\b/, 'the failed-probe label is never offered')

    assert.ok(res.anchored, 'the painted frame still landed on the entrance')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('with no vision axis configured, generation still succeeds and probed is empty', async () => {
  const { store, id, dir } = await fresh()
  try {
    const res = await runGeneration({
      llm: stubLLM([GOOD_OPS]),
      store,
      worldId: id,
      premise: 'a beaver exploring Atlantis',
    })
    assert.deepEqual(res.probed, [], 'nothing was probed — the step is skippable')
    assert.equal(res.states, 5, 'authoring itself is unaffected by the absent axis')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('the pipeline NARRATES itself: paint, probe, author, check — in that order', async () => {
  // One sentence for the whole minute was the shipped behaviour, and it made
  // the expensive middle of the pipeline invisible: a run that silently
  // skipped the probe looked exactly like one that did it. These notes are the
  // only place the pipeline's shape is visible to the person waiting.
  const { store, id, dir } = await fresh()
  try {
    const notes: string[] = []
    await runGeneration({
      llm: stubLLM([JSON.stringify({ objects: [{ object: 'statue', variants: ['statue', 'stone statue'] }] }), GOOD_OPS]),
      store,
      image: stubImage(),
      vision: stubVision(['statue']),
      worldId: id,
      premise: 'a beaver exploring Atlantis',
      progress: (n) => notes.push(n),
    })
    const joined = notes.join(' | ')
    assert.match(joined, /Painting the first frame/, 'paint is announced')
    assert.match(joined, /Probing the frame for statue/, 'the probe names what it is looking for')
    assert.match(joined, /Verified in the frame: statue/, 'and what it actually found')
    assert.match(joined, /Authoring the graph/, 'authoring is its own step')
    assert.match(joined, /Checking it against the doctrine/, 'so is the doctrine check')
    // Order matters as much as presence: paint precedes probe precedes author.
    const at = (re: RegExp) => notes.findIndex((n) => re.test(n))
    assert.ok(at(/Painting/) < at(/Probing/), 'paint before probe')
    assert.ok(at(/Probing/) < at(/Authoring/), 'probe before authoring')
    assert.ok(at(/Authoring/) < at(/doctrine/), 'authoring before the check')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('anchors carry the probe MEASUREMENT, not just the label', async () => {
  // The probe measured minProximity/expectedAspect and threw them away, so
  // every chip armed the moment it was centred, however far away. This pins the
  // stamping — and, through the store, the op shape that silently did nothing.
  const { store, id, dir } = await fresh()
  try {
    const ANCHORED = JSON.parse(GOOD_OPS) as { reply: string; ops: Record<string, unknown>[] }
    ANCHORED.ops = ANCHORED.ops.map((o) =>
      o['name'] === 'swim_in' ? { ...o, anchor: { label: 'statue' } } : o,
    )
    const res = await runGeneration({
      llm: stubLLM([JSON.stringify({ objects: [{ object: 'statue', variants: ['statue', 'stone statue'] }] }), JSON.stringify(ANCHORED)]),
      store,
      image: stubImage(),
      vision: stubVision(['statue', 'stone statue']),
      worldId: id,
      premise: 'a beaver exploring Atlantis',
    })
    assert.equal(res.grounded, 1, 'one anchor was stamped')
    const scene = await store.getScene(id)
    const anchor = scene.events.find((e) => e.name === 'swim_in')?.anchor
    assert.equal(anchor?.label, 'statue')
    // The detector's own verified vocabulary, not the model's guess.
    assert.ok(anchor?.aliases?.includes('stone statue'), 'the probe-verified alias survived the write')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('an EMPTY world is a failure, however politely the model replied', async () => {
  // Caught on camera by the an early pass rollout: a run that named the world, wrote a
  // handsome opening paragraph and authored nothing else sailed through as a
  // success, because the doctrine has no opinion about a world that is merely
  // empty. On screen that is the studio silently doing nothing. The SHAPE the
  // prompt asks for is part of the contract.
  const { store, id, dir } = await fresh()
  try {
    const stub = JSON.stringify({
      name: 'Beaver Atlantis',
      reply: 'I built an underwater realm.',
      ops: [{ op: 'update_state', id: 'opening', patch: { base: 'A rear-view shot of a beaver over a sunken plaza, columns rising in the green water.' } }],
    })
    const llm = stubLLM([stub])
    await assert.rejects(
      () => runGeneration({ llm, store, worldId: id, premise: 'a beaver exploring Atlantis' }),
      (e: unknown) => e instanceof GenerationError && /never authored a world worth playing/.test(e.message),
    )
    // It ASKED for the whole world again before giving up, and the critique
    // names every promise the reply broke — not merely that something was wrong.
    const correction = llm.seen[1]?.messages.at(-1)?.content ?? ''
    assert.match(correction, /does not pass the bar/)
    assert.match(correction, /Only 1 state/)
    assert.match(correction, /Only 0 events/)
    assert.match(correction, /No win ending/)
    // And it took every round it was given rather than failing on the first.
    assert.equal(llm.seen.length, 4)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('a world whose ENTRANCE was never authored comes back for another round', async () => {
  // The subtler cousin of the empty world, and also caught on camera: six
  // states, five events, and the state the player STARTS in still holding the
  // placeholder `world.create` wrote. The graph looked authored; the world
  // opened on a 43-character prompt.
  const { store, id, dir } = await fresh()
  try {
    const leavesEntrance = JSON.stringify({
      name: 'Beaver Atlantis', reply: 'built it',
      // Everything the prompt asks for EXCEPT the one state the player starts
      // in — so the only thing the gate can object to is the entrance.
      ops: [
        { op: 'add_state', id: 'plaza', base: 'A third-person rear-view shot of a beaver over a drowned plaza, columns leaning in the green water, silt drifting.' },
        { op: 'add_state', id: 'vault', base: 'A third-person rear-view shot of a beaver before a sealed vault, gold light along its seams.' },
        { op: 'add_state', id: 'crown', base: 'A third-person rear-view shot of a beaver holding a coral crown as the city wakes around it.' },
        { op: 'add_state', id: 'trench', base: 'A third-person rear-view shot of a beaver above a black trench, the water going cold and empty below.' },
        { op: 'update_state', id: 'crown', patch: { ending: { kind: 'win', title: 'Crowned' } } },
        { op: 'update_state', id: 'trench', patch: { ending: { kind: 'lose', title: 'Lost' } } },
        { op: 'add_event', name: 'swim_in', kind: 'transition', from: ['opening'], to: 'plaza' },
        { op: 'add_event', name: 'listen', kind: 'override', from: ['opening'], detail: 'The water hums with a low, old sound.' },
        { op: 'add_event', name: 'to_vault', kind: 'transition', from: ['plaza'], to: 'vault' },
        { op: 'add_event', name: 'dive', kind: 'transition', from: ['plaza'], to: 'trench' },
        { op: 'add_event', name: 'open_vault', kind: 'transition', from: ['vault'], to: 'crown' },
        { op: 'add_event', name: 'retreat', kind: 'transition', from: ['vault'], to: 'plaza' },
      ],
    })
    const authorsIt = JSON.stringify({
      name: 'Beaver Atlantis', reply: 'and now the opening',
      ops: [{ op: 'update_state', id: 'opening', patch: { base: 'A third-person rear-view shot of a beaver at the gates of a sunken city, marble columns rising into green water on both sides, silt turning in the light.' } }],
    })
    const llm = stubLLM([leavesEntrance, authorsIt])
    const res = await runGeneration({ llm, store, worldId: id, premise: 'a beaver exploring Atlantis' })
    assert.equal(res.rounds, 2, 'the stub entrance cost it a round')

    const correction = llm.seen[1]?.messages.at(-1)?.content ?? ''
    assert.match(correction, /entrance "opening" still holds the placeholder/)
    assert.match(correction, /FIRST thing the player sees/)

    const scene = await store.getScene(id)
    assert.match(scene.states['opening']?.base ?? '', /marble columns/, 'and the entrance really was authored')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('…and if it never authors the entrance, nothing is published as finished', async () => {
  const { store, id, dir } = await fresh()
  try {
    // Idempotent ops, so every round applies cleanly and the ONLY thing wrong
    // is the untouched entrance — which is the condition under test.
    const never = JSON.stringify({
      name: 'Beaver Atlantis', reply: 'built it',
      ops: [
        { op: 'update_state', id: 'opening', patch: { camera: { static: 'eye level', dynamic: 'slow drift' } } },
      ],
    })
    await assert.rejects(
      () => runGeneration({ llm: stubLLM([never]), store, worldId: id, premise: 'a beaver exploring Atlantis' }),
      (e: unknown) => e instanceof GenerationError && /never authored a world worth playing/.test(e.message),
    )
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

// A frame painted and never looked at must SAY so.
//
// Every other probe outcome has words for itself — "could not even ask",
// "the graph is ungrounded", "none passed verification". The one case with no
// words was `painted` with no vision provider at all, because the branch asked
// for `painted && vision`. That silence is what a live recording exposed: an
// entrance whose painted frame showed an interior while its authored prose
// described a footbridge, and nothing in the result mentioned that the graph had
// been written without seeing its own first frame.
test('a world painted with no vision model says the graph never saw its own frame', async () => {
  const { store, id } = await fresh()
  const res = await runGeneration({
    llm: stubLLM([GOOD_OPS]),
    store,
    worldId: id,
    premise: 'a beaver exploring Atlantis',
    image: stubImage(),
    // vision deliberately omitted — the exact shape the live driver had.
  })
  assert.match(res.probeNote ?? '', /never looked at|without seeing/i, 'the silence is broken')
  assert.match(res.probeNote ?? '', /no vision model/i, 'and it names the missing piece')
})

test('an unconfigured vision axis keeps its own distinct words', async () => {
  const { store, id } = await fresh()
  const off: VisionProvider = { id: 'off', label: 'off', isConfigured: () => false, async detect() { return [] } }
  const res = await runGeneration({
    llm: stubLLM([GOOD_OPS]), store, worldId: id, premise: 'x', image: stubImage(), vision: off,
  })
  // "present but not configured" is a different problem from "not supplied" —
  // one is a settings screen, the other is a caller that forgot an argument.
  assert.match(res.probeNote ?? '', /present but not configured/i)
})
