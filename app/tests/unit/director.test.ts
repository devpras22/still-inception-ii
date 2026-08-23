/**
 * The director, tested where it is load-bearing.
 *
 * Three of these tests each pin a real defect: the model does not reliably ask
 * for what it just authored to be played (so the trigger is inferred), a
 * director that can auto-land an ending can kill you without your hand on the
 * controls (so endings are filtered), and a reply that changed nothing must
 * not report success (fail-closed).
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  briefFor,
  batchHoldMs,
  contextFrom,
  deterministicTrigger,
  directAction,
  isChoicePoint,
  objectiveFor,
  rewindTargetFor,
  safeDirectives,
  RECENT_BEATS,
} from '../../src/play/director'
import type { SMScene, SMWorld } from '../../src/world/api'

function scene(): SMScene {
  return {
    states: {
      atrium: { base: 'A third-person rear-view shot of a diver in a flooded atrium, columns rising into green light.' },
      vault: { base: 'A third-person rear-view shot of a diver before a sealed vault, gold light at its seams.' },
      trench: {
        base: 'A third-person rear-view shot of a diver over a black trench, the water going cold.',
        ending: { kind: 'lose', title: 'Lost' },
      },
    },
    events: [
      { name: 'to_vault', kind: 'transition', from: ['atrium'], to: 'vault' },
      { name: 'fall_in', kind: 'transition', from: ['atrium'], to: 'trench' },
    ],
  } as unknown as SMScene
}

test('the brief commits to the literal text and fits it to the live objective', () => {
  const b = briefFor('a dragon smashes through the wall', {
    stateId: 'atrium',
    stateIds: ['atrium', 'vault', 'trench'],
    flags: new Set(['has_key']),
    here: 'A third-person rear-view shot of a diver in a flooded atrium.',
    subject: 'a diver in a brass helmet',
    objective: 'The Vault — right now: find the key',
  })
  assert.match(b, /"a dragon smashes through the wall"/)
  assert.match(b, /never a security drone/)
  assert.match(b, /atrium_a_dragon_smashes_thro/) // the aftermath id, from the text
  assert.match(b, /The live objective: The Vault — right now: find the key/)
  assert.match(b, /Reuse this subject lock verbatim.*brass helmet/)
  assert.match(b, /NEVER edit `atrium`/)
  assert.match(b, /never land an ending/)
  assert.match(b, /TWO visible transitions/)
})

test('with no mission the brief still refuses to be disconnected spectacle', () => {
  const b = briefFor('it starts raining fish', { stateId: 'atrium', stateIds: ['atrium'], flags: new Set() })
  assert.match(b, /declares no objective, so tie it to the place itself/)
  assert.doesNotMatch(b, /subject lock/)
})

test('the objective is the ACTIVE step of an unfinished mission', () => {
  const missions = [
    {
      id: 'm1',
      title: 'The Vault',
      objectives: [
        { id: 'find_key', text: 'Find the key' },
        { id: 'open_it', text: 'Open the vault' },
      ],
    },
  ]
  assert.match(objectiveFor(missions, new Set()) ?? '', /Find the key/)
  assert.match(objectiveFor(missions, new Set(['find_key'])) ?? '', /Open the vault/)
  // Finished missions are not the story any more.
  assert.equal(objectiveFor(missions, new Set(['find_key', 'open_it'])), undefined)
  assert.equal(objectiveFor(undefined, new Set()), undefined)
})

test('the trigger is the fresh transition OUT OF where the player stands', () => {
  const before = new Set(['to_vault', 'fall_in'])
  const after = [
    ...scene().events,
    // A reaction, hanging off the aftermath state — not the action.
    { name: 'bait_it', kind: 'transition', from: ['atrium_dragon'], to: 'atrium_loose' },
    { name: 'a_dragon_smashes_in', kind: 'transition', from: ['atrium'], to: 'atrium_dragon' },
  ] as unknown as SMScene['events']
  assert.deepEqual(deterministicTrigger(before, after, 'atrium'), [{ fire: 'a_dragon_smashes_in' }])
  // Nothing fresh: nothing to play, and the caller must not invent one.
  assert.equal(deterministicTrigger(before, scene().events, 'atrium'), null)
})

test('the director may never auto-land an ending', () => {
  const s = scene()
  assert.deepEqual(safeDirectives(s, [{ fire: 'fall_in' }]), [], 'that transition ends the run')
  assert.deepEqual(safeDirectives(s, [{ goto: 'trench' }]), [], 'and so does that jump')
  assert.deepEqual(safeDirectives(s, [{ fire: 'to_vault' }]), [{ fire: 'to_vault' }])
  assert.deepEqual(safeDirectives(s, [{ goto: 'nowhere' }]), [], 'a state that does not exist is not playable')
})

test('a batch is held long enough to actually perform', () => {
  assert.ok(batchHoldMs([{ fire: 'x' }]) > 7000)
  assert.ok(batchHoldMs([{ goto: 'vault' }]) < batchHoldMs([{ fire: 'x' }]))
  assert.equal(batchHoldMs([{ goto: 'vault', afterMs: 500 }]), 1200 + 500 + 800)
})

test('a choice point is a state with two legal doors, and rewind goes back to it', () => {
  const s = scene()
  assert.equal(isChoicePoint(s, 'atrium', new Set()), true)
  assert.equal(isChoicePoint(s, 'vault', new Set()), false)

  // A locked door is not a choice until its flag is held.
  const gated = scene()
  gated.events[1] = { ...gated.events[1], requires: ['has_key'] } as never
  assert.equal(isChoicePoint(gated, 'atrium', new Set()), false)
  assert.equal(isChoicePoint(gated, 'atrium', new Set(['has_key'])), true)

  assert.equal(rewindTargetFor(['atrium', 'vault'], 'vault'), 'atrium')
  assert.equal(rewindTargetFor(['atrium'], 'atrium'), null, 'rewinding to where you already are is not a rewind')
  assert.equal(rewindTargetFor([], 'atrium'), null)
})

test('a typed action authors, and what it authored is what gets played', async () => {
  const live = scene()
  const out = await directAction({
    text: 'a dragon smashes through the wall',
    ctx: { stateId: 'atrium', stateIds: ['atrium', 'vault', 'trench'], flags: new Set() },
    readScene: async () => ({ states: live.states, events: [...live.events] }),
    kernel: async (instruction) => {
      assert.match(instruction, /a dragon smashes through the wall/)
      live.states['atrium_dragon'] = { base: 'A third-person rear-view shot of a diver amid wreckage, the beast coiled over the racks.' } as never
      live.events.push({ name: 'a_dragon_smashes_in', kind: 'transition', from: ['atrium'], to: 'atrium_dragon' } as never)
      live.events.push({ name: 'bait_it', kind: 'transition', from: ['atrium_dragon'], to: 'vault' } as never)
      return { reply: 'the wall goes', applied: 3 }
    },
  })
  assert.equal(out.ok, true)
  assert.equal(out.applied, 3)
  assert.deepEqual(out.play, [{ fire: 'a_dragon_smashes_in' }], 'the action, not the reaction')
  assert.deepEqual(out.authored, ['a_dragon_smashes_in', 'bait_it'])
})

test('a kernel that changed nothing plays nothing and admits it', async () => {
  const live = scene()
  const out = await directAction({
    text: 'nothing in particular',
    ctx: { stateId: 'atrium', stateIds: ['atrium'], flags: new Set() },
    readScene: async () => live,
    kernel: async () => ({ reply: 'I could not think of anything', applied: 0 }),
  })
  assert.equal(out.ok, false)
  assert.deepEqual(out.play, [])
  assert.match(out.say, /could not think of anything/)
})

test('a kernel that claims ops but writes none is caught by re-reading the scene', async () => {
  // The claim is the model's; the scene is the truth. That rule again:
  // an op that the store silently dropped must not read as a staged action.
  const live = scene()
  const out = await directAction({
    text: 'a dragon',
    ctx: { stateId: 'atrium', stateIds: ['atrium'], flags: new Set() },
    readScene: async () => live,
    kernel: async () => ({ reply: 'done!', applied: 4 }),
  })
  assert.equal(out.ok, false)
  assert.deepEqual(out.authored, [])
})

test('a REJECTED batch comes back as a correction, and the retry lands', async () => {
  // The exact failure filmed on a live session: a real kernel emitted
  // `add_event` with `to: opening_a_whale_glides_down_thro` before adding that
  // state, the store refused the batch whole, and a single-shot director died
  // on an ordering detail. This survives it by handing the store's own words
  // back.
  const live = scene()
  const briefs: string[] = []
  const rounds: string[] = []
  const out = await directAction({
    text: 'a whale glides down through the water above me',
    ctx: { stateId: 'atrium', stateIds: ['atrium'], flags: new Set() },
    readScene: async () => ({ states: live.states, events: [...live.events] }),
    onRound: (_n, why) => rounds.push(why),
    kernel: async (instruction) => {
      briefs.push(instruction)
      if (briefs.length === 1) throw new Error('No such state: atrium_a_whale_glides_down_th.')
      live.states['atrium_whale'] = { base: 'A third-person rear-view shot of a diver as a whale slides overhead, its shadow crossing the floor.' } as never
      live.events.push({ name: 'a_whale_glides_down', kind: 'transition', from: ['atrium'], to: 'atrium_whale' } as never)
      return { reply: 'it passes overhead', applied: 2 }
    },
  })
  assert.equal(out.ok, true)
  assert.deepEqual(out.play, [{ fire: 'a_whale_glides_down' }])
  assert.equal(briefs.length, 2, 'it asked again')
  // The second brief QUOTES the store, so the model is told which id was missing.
  assert.match(briefs[1] ?? '', /REJECTED AND NOTHING WAS APPLIED: No such state: atrium_a_whale_glides_down_th/)
  assert.match(briefs[1] ?? '', /added BEFORE any event that names it as "to"/)
  assert.deepEqual(rounds, ['No such state: atrium_a_whale_glides_down_th.'])
})

test('the brief tells the kernel the ordering the store enforces', () => {
  const b = briefFor('a whale', { stateId: 'atrium', stateIds: ['atrium'], flags: new Set() })
  assert.match(b, /emit each add_state BEFORE the add_event whose "to" names it/)
})

test('a kernel that throws is reported, not leaked', async () => {
  const out = await directAction({
    text: 'a dragon',
    ctx: { stateId: 'atrium', stateIds: ['atrium'], flags: new Set() },
    readScene: async () => scene(),
    kernel: async () => { throw new Error('no LLM provider is configured') },
  })
  assert.equal(out.ok, false)
  assert.match(out.say, /could not stage that after 3 tries — no LLM provider is configured/)
  assert.deepEqual(out.play, [])
})

test('the context is read off the world, so the brief inherits its locks', () => {
  const world = {
    subject: 'a diver in a brass helmet',
    styleTail: 'shot on 35mm, heavy grain',
    missions: [{ id: 'm', title: 'The Vault', objectives: [{ id: 'find_key', text: 'Find the key' }] }],
  } as unknown as SMWorld
  const ctx = contextFrom(world, scene(), 'atrium', new Set())
  assert.equal(ctx.subject, 'a diver in a brass helmet')
  assert.equal(ctx.styleTail, 'shot on 35mm, heavy grain')
  assert.match(ctx.objective ?? '', /Find the key/)
  assert.match(ctx.here ?? '', /flooded atrium/)
  assert.deepEqual([...ctx.stateIds].sort(), ['atrium', 'trench', 'vault'])
})

test('the brief carries what ALREADY HAPPENED, so an improv stops repeating itself', () => {
  // A running outline is kept so the director doesn't contradict or repeat
  // it — and without it every typed action is answered from a blank slate:
  // the graph shows a state called `atrium_dragon`, and nothing says a dragon
  // already came through the wall.
  const b = briefFor('something else happens', {
    stateId: 'atrium',
    stateIds: ['atrium'],
    flags: new Set(),
    logline: 'A diver looting a city that does not want to be looted.',
    recentBeats: ['a dragon smashes through the wall — the wall goes', 'the lights go out — darkness'],
  })
  assert.match(b, /What this world is: A diver looting a city/)
  assert.match(b, /do NOT repeat or contradict these/)
  assert.match(b, /· a dragon smashes through the wall/)
  assert.match(b, /· the lights go out/)

  // A world with no story says nothing about the past rather than pretending.
  const blank = briefFor('x', { stateId: 'atrium', stateIds: ['atrium'], flags: new Set() })
  assert.doesNotMatch(blank, /Already happened/)
  assert.doesNotMatch(blank, /What this world is/)
})

test('the director is told the RECENT past, not all of it', () => {
  const world = {
    story: {
      logline: 'x',
      beats: Array.from({ length: 20 }, (_, i) => ({ summary: `beat ${i}` })),
    },
  } as unknown as SMWorld
  const ctx = contextFrom(world, scene(), 'atrium', new Set())
  assert.equal(ctx.recentBeats?.length, RECENT_BEATS)
  // The NEWEST, which is what an improv has to stay consistent with.
  assert.equal(ctx.recentBeats?.[ctx.recentBeats.length - 1], 'beat 19')
})

// The model's own goto-chain is honoured when nothing fresh is playable.
//
// The agent's gotos are kept in exactly that case — the pacing is a creative
// call that can't be inferred — and they used to be parsed nowhere and passed
// nowhere, so `picked` could only ever hold ONE inferred beat. That is why the
// player dropping everything after the first was invisible: no batch of more
// than one directive could reach it.
test('the agent\'s goto-chain is kept when there is nothing fresh to fire', () => {
  const known = new Set(['already_here'])
  const events = [{ name: 'already_here', kind: 'transition' as const, from: ['a'], to: 'b', base: 'x' }]
  const asked = [{ goto: 'b' }, { goto: 'c', afterMs: 900 }]

  // Nothing fresh was authored, so the trigger has no action to infer — and
  // the chain the model asked for survives, in order, with its pacing.
  assert.deepEqual(deterministicTrigger(known, events, 'a', undefined, asked), asked)

  // A FRESH transition out of the current state still wins: the thing just
  // authored is the action, and the model's chain is the fallback, not a rival.
  const fresh = [...events, { name: 'new_move', kind: 'transition' as const, from: ['a'], to: 'b', base: 'y' }]
  assert.deepEqual(deterministicTrigger(known, fresh, 'a', undefined, asked), [{ fire: 'new_move' }])

  // Only gotos are taken from the model: a `fire` it names is a claim about the
  // graph, and the graph is what `safeDirectives` checks.
  assert.deepEqual(deterministicTrigger(known, events, 'a', undefined, [{ fire: 'anything' }]), null)
  assert.equal(deterministicTrigger(known, events, 'a', undefined, []), null)
})
