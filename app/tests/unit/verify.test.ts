/**
 * The hard test, tested.
 *
 * `verifyWorld` exists because the doctrine answers a different question: a
 * world can pass every lint and still be unplayable, since nothing in an empty
 * room is incorrect. This was found twice on camera — a world with one
 * state and no events, and a world whose entrance was never written — so the
 * cases below are those two plus the ones this gate scores.
 *
 * The line that matters most: the gate FAILS only what the kernel prompt
 * promises, and merely ADVISES beyond it. A gate that fails work nobody asked
 * for teaches authors to ignore it, so "no flag-gated choices" is an issue and
 * never a failure.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { verifyWorld, critique, reachableFrom } from '../../src/world/verify'
import type { SMWorld } from '../../src/world/api'

/** A world that passes: 5 states, 6 events, a branch, a win and a lose. */
function goodWorld(): SMWorld {
  const state = (base: string, ending?: { kind: 'win' | 'lose'; title: string }) => ({
    base,
    camera: { static: 'rear chase, eye level', dynamic: 'rear chase, drifting' },
    movement: { static: 'standing still', dynamic: 'walking on' },
    ...(ending ? { ending } : {}),
  })
  return {
    entrance: { state: 'gate' },
    scene: {
      states: {
        gate: state('A third-person rear-view shot of a diver at the gates of a sunken city, columns rising in green water.'),
        plaza: state('A third-person rear-view shot of a diver in a drowned plaza, statues leaning in the current.'),
        vault: state('A third-person rear-view shot of a diver before a sealed vault, gold light at its seams.'),
        crown: state('A third-person rear-view shot of a diver holding a coral crown as the city wakes.', { kind: 'win', title: 'Crowned' }),
        trench: state('A third-person rear-view shot of a diver over a black trench, the water going cold.', { kind: 'lose', title: 'Lost' }),
      },
      events: [
        { name: 'swim_in', kind: 'transition', from: ['gate'], to: 'plaza' },
        { name: 'listen', kind: 'override', from: ['gate'], detail: 'The water hums.' },
        { name: 'to_vault', kind: 'transition', from: ['plaza'], to: 'vault' },
        { name: 'to_trench', kind: 'transition', from: ['plaza'], to: 'trench' },
        { name: 'open_vault', kind: 'transition', from: ['vault'], to: 'crown', grants: ['has_crown'] },
        { name: 'retreat', kind: 'transition', from: ['vault'], to: 'plaza' },
      ],
    },
  } as unknown as SMWorld
}

test('a world that keeps the prompt\'s promises passes', () => {
  const v = verifyWorld(goodWorld(), { premise: 'a diver in a sunken city' })
  assert.equal(v.pass, true, v.issues.join(' · '))
  // TWO forks, not one: the plaza chooses vault-or-trench, and the vault
  // chooses crown-or-retreat. Counting them was worth doing by hand.
  assert.equal(v.stats.branchPoints, 2)
  assert.equal(v.stats.winStates, 1)
  assert.equal(v.stats.loseStates, 1)
  assert.ok(v.score >= 70, `score was ${v.score}`)
})

test('the empty world — the one that shipped as a success — fails', () => {
  const w = { entrance: { state: 'opening' }, scene: { states: { opening: { base: 'A third-person rear-view shot of a beaver over a sunken plaza, columns rising.' } }, events: [] } } as unknown as SMWorld
  const v = verifyWorld(w, { premise: 'a beaver exploring Atlantis' })
  assert.equal(v.pass, false)
  assert.match(v.issues.join(' '), /Only 1 state/)
  assert.match(v.issues.join(' '), /Only 0 events/)
})

test('the unwritten entrance — the other one — fails, even with a full graph', () => {
  const w = goodWorld()
  w.scene.states['gate']!.base = 'a diver in a sunken city' // the premise, verbatim
  const v = verifyWorld(w, { premise: 'a diver in a sunken city' })
  assert.equal(v.pass, false)
  assert.match(v.issues.join(' '), /entrance "gate" still holds the placeholder/)
  assert.match(v.issues.join(' '), /FIRST thing the player sees/)
})

test('a path that simply STOPS is a failure, and an ENDING is not', () => {
  const w = goodWorld()
  // Held by reference so the ending can be added below: writing `as never` into
  // the map narrows the element access to `never`, and then nothing can be set
  // on it.
  const dock: { base: string; ending?: { kind: 'win' | 'lose'; title: string } } = {
    base: 'A third-person rear-view shot of a diver on a stone dock, the city below.',
  }
  w.scene.states['dock'] = dock as never
  w.scene.events.push({ name: 'climb_out', kind: 'transition', from: ['plaza'], to: 'dock' } as never)
  const v = verifyWorld(w, {})
  assert.equal(v.pass, false)
  assert.deepEqual(v.stats.danglingEnds, ['dock'])
  assert.match(v.issues.join(' '), /leaves the player standing in it/)

  // Make it an ending and the same shape is fine.
  dock.ending = { kind: 'lose', title: 'Surfaced' }
  assert.equal(verifyWorld(w, {}).pass, true)
})

test('an unreachable state fails; reachability follows transitions only', () => {
  const w = goodWorld()
  w.scene.states['attic'] = { base: 'A third-person rear-view shot of a diver in a flooded attic nobody can reach.', ending: { kind: 'lose', title: 'Stuck' } } as never
  const v = verifyWorld(w, {})
  assert.equal(v.pass, false)
  assert.deepEqual(v.stats.unreachable, ['attic'])

  const reach = reachableFrom('gate', w)
  assert.deepEqual([...reach].sort(), ['crown', 'gate', 'plaza', 'trench', 'vault'])
})

test('a world with no branch fails; overrides are not branches', () => {
  const w = goodWorld()
  // Remove BOTH forks: the plaza leads only to the vault, and the vault only
  // onward to the crown.
  w.scene.events = w.scene.events.filter((e) => e.name !== 'to_trench' && e.name !== 'retreat')
  w.scene.states['trench']!.ending = { kind: 'lose', title: 'Lost' }
  w.scene.events.push({ name: 'fall_in', kind: 'transition', from: ['crown'], to: 'trench' } as never)
  w.scene.events.push({ name: 'shout', kind: 'override', from: ['plaza'], detail: 'The sound goes nowhere.' } as never)
  const v = verifyWorld(w, {})
  assert.equal(v.stats.branchPoints, 0, 'an override does not make a decision point')
  assert.equal(v.pass, false)
  assert.match(v.issues.join(' '), /No real decision point/)
})

test('missing endings fail, each in its own words', () => {
  const noWin = goodWorld()
  noWin.scene.states['crown']!.ending = { kind: 'lose', title: 'Also lost' }
  assert.match(verifyWorld(noWin, {}).issues.join(' '), /No win ending/)

  const noLose = goodWorld()
  delete noLose.scene.states['trench']!.ending
  noLose.scene.events.push({ name: 'back_up', kind: 'transition', from: ['trench'], to: 'plaza' } as never)
  assert.match(verifyWorld(noLose, {}).issues.join(' '), /No lose ending/)
})

test('flag-gated choices are ADVISED, never failed', () => {
  const w = goodWorld()
  delete w.scene.events.find((e) => e.name === 'open_vault')!.grants
  const v = verifyWorld(w, {})
  assert.equal(v.stats.gatedChoices, 0)
  assert.match(v.issues.join(' '), /changes what is available later/)
  assert.equal(v.pass, true, 'the prompt never asked for flags, so their absence cannot fail a world')
})

test('doctrine errors are carried into the verdict', () => {
  const v = verifyWorld(goodWorld(), { lintErrors: 2 })
  assert.equal(v.pass, false)
  assert.match(v.issues.join(' '), /2 doctrine error/)
})

test('the critique reads like something a person would say', () => {
  const w = { entrance: { state: 'a' }, scene: { states: { a: { base: 'short' } }, events: [] } } as unknown as SMWorld
  const text = critique(verifyWorld(w, { premise: 'x' }))
  assert.match(text, /does not pass the bar \(\d+\/100\)/)
  assert.match(text, /1 states, 0 events/)
  // It used to say "Emit the WHOLE world again", and that sentence was a bug:
  // the ops have already been applied by the time there is a world to score, so
  // a full re-emit re-sends `add_state` for states that now exist and the store
  // refuses the batch. Measured as one of two kernel failures in twenty.
  assert.match(text, /ALREADY WRITTEN/)
  assert.doesNotMatch(text, /WHOLE world again/)
})

/**
 * Reading a REASONING model's reply.
 *
 * The kernel's last remaining failure mode — 1 generation in 20 — was four
 * rounds of "that was not valid JSON" about answers that were, in fact,
 * complete: both captured raws ended in a clean `}`. The salvage took the FIRST
 * `{` to the LAST `}` and parsed the span between, which is right only when the
 * model says nothing else. A reasoning model thinks out loud first, and its
 * thinking is full of braces.
 */
test('the reply reader finds the ANSWER inside a reasoning model\'s chatter', async () => {
  const { extractJson, ReplyParseError } = await import('../../src/author/agent/reply')

  const answer = { reply: 'done', ops: [{ op: 'add_state', id: 'a', base: 'x' }] }
  const shapes: [string, string][] = [
    ['a brace in the preamble', `I should use {"op":"add_state"} here.\n\n${JSON.stringify(answer)}`],
    ['a stray brace after', `${JSON.stringify(answer)}\n\nNote: the } above closes it.`],
    ['thinking object first', `{"thought":"planning"}\n${JSON.stringify(answer)}`],
    ['fenced', '```json\n' + JSON.stringify(answer) + '\n```'],
    ['exactly the object', JSON.stringify(answer)],
  ]
  for (const [name, raw] of shapes) {
    assert.deepEqual(extractJson(raw), answer, name)
  }

  // A brace inside AUTHORED PROSE must not end the object early — the depth
  // scan has to respect string literals.
  const prosey = { reply: 'ok', ops: [{ op: 'add_state', id: 'a', base: 'a door {ajar} in the wall' }] }
  assert.deepEqual(extractJson(JSON.stringify(prosey)), prosey)

  // And it still refuses a reply with no object in it at all, rather than
  // inventing one — the caller's next move is to write somebody's world.
  assert.throws(() => extractJson('I am afraid I cannot do that.'), ReplyParseError)
})
