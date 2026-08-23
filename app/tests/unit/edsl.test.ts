/**
 * The language, and its acceptance oracle.
 *
 * The oracle first, because it is the one that matters: the world this studio
 * SHIPS, re-authored as a program (`examples/walk-to-the-bench.sc.ts`), must
 * compile deep-equal to the store's own copy. That is the standard worth
 * holding an eDSL to, for two reasons — a language that cannot express the
 * world you actually ship is not a language, and a compiler that changes that
 * world's bytes is a liability. Everything else here pins one rule of one layer.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'

import { frag, both, world, see, either, CompileError, EvidenceError, candidateFor } from '../../src/author/edsl'
import { promptForBeat } from '../../src/play/episode'
import { starterSceneForTest } from '../../src/world/store/local'
import { program as starterProgram } from '../../examples/walk-to-the-bench.sc'

test('THE ORACLE: the shipped world, re-authored as a program, compiles byte-equal', () => {
  const { world: compiled, warnings } = starterProgram.compile()
  assert.deepEqual(compiled.scene, starterSceneForTest(), 'the compiler changed the shipped world')

  // It carries exactly the one warning the shipped world is meant to carry —
  // the anchor with no minimum on-screen size — and no errors, or `compile()`
  // would have thrown before this line.
  assert.deepEqual(warnings.map((w) => w.lint), ['sliver-evidence'])
})

test('the whitespace law: authored across lines, compiled to one', () => {
  const f = frag`A narrow dirt lane
      between low stone walls,
      late afternoon.`
  assert.equal(f.text, 'A narrow dirt lane between low stone walls, late afternoon.')
  // Plain strings are NOT normalized — hand-written prose round-trips exactly,
  // which is what makes the oracle above possible.
  assert.equal(world('w').state('a', { base: '  two  spaces  ' }).assembleUnchecked().scene.states['a']?.base,
    '  two  spaces  ')
})

test('an allow() travels with the prose it excuses', () => {
  const SAFE = frag`no birds here`.allow('negation')
  const composed = frag`A lane. ${SAFE} Long shadows.`
  assert.equal(composed.allowed.has('negation'), true, 'suppression rides the interpolation')
  assert.equal(frag`plain`.allowed.size, 0)
})

test('both() is the layer pair where one line serves at rest and in motion', () => {
  assert.deepEqual(both(frag`walking  on`), { static: 'walking on', dynamic: 'walking on' })
})

test('evidence is an algebra, and an unrepresentable contract fails at author time', () => {
  assert.deepEqual(see.bright(70).hits(2).within(9000).auto().toLandWhen(), {
    minLuminance: 70, hits: 2, timeoutMs: 9000, auto: true,
  })
  assert.deepEqual(
    either(see.bright(70), see.a('door', { aliases: ['gate'], minExtent: 0.15 })).toLandWhen(),
    { minLuminance: 70, label: 'door', aliases: ['gate'], minExtent: 0.15 },
  )
  // landWhen holds ONE value per clause. Two brightness bands cannot be
  // represented, so the merge throws HERE rather than silently keeping one.
  assert.throws(() => either(see.bright(70), see.bright(90)), EvidenceError)
  // Merging the same value twice is not a conflict.
  assert.doesNotThrow(() => either(see.bright(70), see.bright(70)))
})

test('compile() REFUSES a world that breaks the doctrine — with the field path', () => {
  const bad = world('bad', { entrance: { state: 'a' } })
    .state('a', { base: 'A room with no windows.' })
    .state('b', { base: 'A hallway.', ending: { kind: 'win', title: 'Out' } })
    .event('go', { kind: 'transition', from: ['a'], to: 'b' })

  let err: unknown
  try { bad.compile() } catch (e) { err = e }
  assert.ok(err instanceof CompileError, 'a doctrine error must refuse to compile')
  const negation = err.diagnostics.find((d) => d.lint === 'negation')
  assert.ok(negation, 'the negation in the state prose is what failed it')
  assert.equal(negation.path, 'states.a.base', 'the diagnostic names the exact field')

  // check() is the same pass without the throw — tsc's --noEmit.
  assert.ok(bad.check().some((d) => d.lint === 'negation'))
})

test('allow() downgrades a text lint to a VISIBLE info, and cannot waive a structural one', () => {
  const excused = world('ok', { entrance: { state: 'a' } })
    .state('a', { base: frag`A room with no windows.`.allow('negation') })
    .state('b', { base: 'A hallway.', ending: { kind: 'win', title: 'Out' } })
    .event('go', { kind: 'transition', from: ['a'], to: 'b' })

  const { warnings } = excused.compile()
  const info = warnings.find((d) => d.lint === 'negation')
  assert.equal(info?.severity, 'info', 'suppressed, never silent')
  assert.match(info?.message ?? '', /suppressed by allow\('negation'\)/)

  // A dangling reference is a graph property, not a matter of taste: no
  // fragment can excuse it, and the world still refuses to compile.
  const structural = world('bad', { entrance: { state: 'a' } })
    .state('a', { base: frag`A room.`.allow('dangling-ref') })
    .event('go', { kind: 'transition', from: ['a'], to: 'nowhere' })
  assert.throws(() => structural.compile(), CompileError)
})

test('the builder is a VALUE: adding to a program never mutates it', () => {
  const base = world('w').state('a', { base: 'A room.' })
  const forked = base.state('b', { base: 'A hallway.' })
  assert.deepEqual(Object.keys(base.assembleUnchecked().scene.states), ['a'])
  assert.deepEqual(Object.keys(forked.assembleUnchecked().scene.states), ['a', 'b'])
})

test('a program can declare a MISSION, and the graph behind it compiles itself', () => {
  const w = world('dive', { entrance: { state: 'dock' }, name: 'The Dive' })
    .state('dock', {
      base: frag`A rear-view shot of a diver on a stone dock over green water.`,
      camera: { static: 'rear chase, eye level', dynamic: 'rear chase, drifting' },
      movement: { static: 'standing still', dynamic: 'swimming forward' },
    })
    .mission({
      id: 'pearl', title: 'The Pearl',
      objectives: [
        { id: 'open', text: 'Open the shell', action: 'The blade slips into the seam and the shell parts.', grounded: { target: 'shell' } },
        { id: 'take', text: 'Take the pearl', action: 'The pearl comes free into a gloved hand.', outcome: 'The shell lies open and empty on the sand.' },
      ],
    })

  const { world: sm } = w.compile()
  // The quest record is there…
  assert.equal(sm.missions?.[0]?.objectives.length, 2)
  // …and so is the GRAPH it compiled into: two events, chained by flags, with
  // the win stamped on a scene reached only by finishing.
  assert.deepEqual(sm.scene.events.map((e) => e.name), ['Open the shell', 'Take the pearl'])
  assert.deepEqual(sm.scene.events[1]?.requires, ['open'])
  assert.equal(sm.scene.states['dock__take']?.ending?.kind, 'win')
  // A program that declares a quest never also hand-authors it, so the two
  // cannot drift.
})

test('variants ride along as the state\'s A/B alternates', () => {
  const sm = world('w')
    .state('a', {
      base: 'A quiet room.',
      variants: [{ label: 'B', base: frag`A quiet room,  lit  only by a lamp.` }],
    })
    .assembleUnchecked()
  assert.deepEqual(sm.scene.states['a']?.variants, [{ label: 'B', base: 'A quiet room, lit only by a lamp.' }])
})

// The eDSL could describe a world and check evidence against a recording, but
// had no way to ask what the model will actually be TOLD when an event fires —
// so comparing two phrasings meant hand-copying prose out of a compiled world.
// A REPLICA of the player's assembler would answer it and would drift out of
// step the first time either side changed; `candidateFor` calls the player's own
// `promptForBeat`, so a candidate cannot disagree with what streams.
test('a candidate is the exact prose the player would stream, static and dynamic', () => {
  const p = world('lane', { entrance: { state: 'kerb' } })
    .state('kerb', {
      base: 'A rear view of a woman at the kerb.',
      camera: { static: 'eye level, still', dynamic: 'a slow push in' },
      movement: { static: 'she waits', dynamic: 'she steps off' },
    })
    .state('road', { base: 'The middle of the road.' })
    .event('cross', { kind: 'transition', from: ['kerb'], to: 'road', base: 'She crosses.' })

  const still = candidateFor(p, 'cross')
  // The event overrides the prose; the camera and movement fall back to the
  // STATE, which is what makes an event a change to a scene, not a new scene.
  assert.equal(still.text, 'She crosses. eye level, still she waits')
  assert.equal(still.id, 'lane.cross.kerb.static')

  const moving = candidateFor(p, 'cross', { variant: 'dynamic' })
  assert.equal(moving.text, 'She crosses. a slow push in she steps off')
  assert.notEqual(moving.text, still.text, 'the travelling layers are a different candidate')

  // The assembler is the player's, not a copy of it: same inputs, same string.
  assert.equal(
    still.text,
    promptForBeat({ text: 'She crosses.', camera: 'eye level, still', movement: 'she waits' }),
  )
})

test('asking for an event a program does not have names the ones it does', () => {
  const p = world('lane', { entrance: { state: 'kerb' } })
    .state('kerb', { base: 'A kerb.' })
    .state('road', { base: 'A road.' })
    .event('cross', { kind: 'transition', from: ['kerb'], to: 'road', base: 'She crosses.' })
  assert.throws(() => candidateFor(p, 'fly'), (e: Error) => {
    assert.match(e.message, /no event named "fly"/)
    assert.match(e.message, /cross/, 'and says what there IS, so the typo is obvious')
    return true
  })
})
