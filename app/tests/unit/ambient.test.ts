/**
 * The ambient transients, as values.
 *
 * Every state the kernel authors carries two or three of these, and for a
 * long time nothing read them: they were in the schema, in the eDSL, on a
 * chip in the graph, and inert in every world this project has made. The
 * scheduling lives in a component, so the DECISIONS live here — a mechanic
 * whose choosing and timing are both inside an effect can only be checked by
 * watching it, which is how such a thing stays unverified for a long time.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { AMBIENT, ambientWait, nextAmbient, promptWithAmbient } from '../../src/play/ambient'

test('a transient is never the same line twice running', () => {
  const pool = ['A gull calls.', 'Water slaps the wall.']
  // The draw that WOULD repeat index 0 is pushed on rather than re-rolled:
  // re-rolling can repeat too, and with a two-line pool a fair coin says the
  // same thing half the time, which reads as broken rather than atmospheric.
  assert.equal(nextAmbient(pool, 0, 0.1)?.index, 1)
  assert.equal(nextAmbient(pool, 1, 0.9)?.index, 0)
  // With nothing shown yet, the draw stands.
  assert.equal(nextAmbient(pool, -1, 0.1)?.index, 0)
})

test('a single-line pool repeats rather than falling silent', () => {
  // The no-repeat rule must not empty a pool of one: a state with one ambient
  // detail should still get it, or authoring one line would mean authoring none.
  const only = ['Rain ticks on the gutter.']
  assert.equal(nextAmbient(only, 0, 0.5)?.line, 'Rain ticks on the gutter.')
})

test('an empty or blank pool yields nothing at all', () => {
  assert.equal(nextAmbient([], -1, 0.5), null)
  assert.equal(nextAmbient(['   ', ''], -1, 0.5), null, 'whitespace is not a transient')
})

test('the draw stays inside the pool at the extremes', () => {
  const pool = ['a', 'b', 'c']
  // A roll of exactly 1 would index off the end — the clamp is why this cannot
  // return undefined and call it a line.
  assert.equal(nextAmbient(pool, -1, 1)?.line, 'c')
  assert.equal(nextAmbient(pool, -1, 0)?.line, 'a')
})

test('the wait stays inside the shipped cadence', () => {
  assert.equal(ambientWait(0), AMBIENT.minWaitMs)
  assert.equal(ambientWait(1), AMBIENT.maxWaitMs)
  assert.ok(ambientWait(0.5) > AMBIENT.minWaitMs && ambientWait(0.5) < AMBIENT.maxWaitMs)
  assert.ok(AMBIENT.holdMs < AMBIENT.minWaitMs, 'a transient clears before the next is due')
})

test('a transient is added to the scene, never substituted for it', () => {
  const base = 'A rear view of a woman on a footbridge.'
  assert.equal(promptWithAmbient(base, 'A gull calls.'), `${base} A gull calls.`)
  // Taking it back off must restore the state prose exactly: this is the second
  // send the player makes, and a mismatch would leave the world drifting on a
  // prompt the author never wrote.
  assert.equal(promptWithAmbient(base, null), base)
  assert.equal(promptWithAmbient(base, '   '), base)
})
