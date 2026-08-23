/**
 * Swapping a state for one of its variants, at play.
 *
 * `worldWithVariant` is what makes an A/B arm playable: `?variant=<label>`
 * streams the alternate prompt for one state instead of the authored one. It
 * had NO tests — three references in `src/`, none in `tests/` — which is how a
 * function whose whole job is to replace prose about to be sent to a world model
 * goes unchecked.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { worldWithVariant } from '../../src/world'
import type { SMWorld } from '../../src/world'

const world = (): SMWorld => ({
  scene: {
    states: {
      lane: {
        base: 'The lane, as authored.',
        camera: { static: 'eye level', dynamic: 'a slow push' },
        movement: { static: 'she waits', dynamic: 'she walks' },
        ambient: ['A gull calls.'],
        variants: [
          { label: 'B', base: 'The lane, colder.', camera: { static: 'low', dynamic: 'a drift' } },
          { label: 'C', base: 'The lane at dusk.' },
        ],
      },
      gate: { base: 'A gate.' },
    },
    events: [],
  },
})

test('a variant replaces the prose, and only for the state it belongs to', () => {
  const out = worldWithVariant(world(), 'lane', 'B')
  assert.equal(out.scene.states['lane']?.base, 'The lane, colder.')
  assert.equal(out.scene.states['gate']?.base, 'A gate.', 'no other state is touched')
  // The original is left alone: the player holds a swapped COPY, and a caller
  // that mutated the stored world would persist an A/B arm as the author's text.
  assert.equal(world().scene.states['lane']?.base, 'The lane, as authored.')
})

test('a variant overrides only the layers it actually carries', () => {
  const out = worldWithVariant(world(), 'lane', 'B')
  const lane = out.scene.states['lane']
  assert.equal(lane?.camera?.static, 'low', 'the variant brought its own camera')
  // It carries no movement or ambient, so the authored ones stand — an arm that
  // changes the prose should not silently blank the scene around it.
  assert.equal(lane?.movement?.static, 'she waits')
  assert.deepEqual(lane?.ambient, ['A gull calls.'])

  // And an arm that carries nothing but prose keeps every layer.
  const c = worldWithVariant(world(), 'lane', 'C').scene.states['lane']
  assert.equal(c?.base, 'The lane at dusk.')
  assert.equal(c?.camera?.static, 'eye level')
})

test('the played copy carries no variant list, so a swap cannot compound', () => {
  const out = worldWithVariant(world(), 'lane', 'B')
  assert.equal(out.scene.states['lane']?.variants, undefined)
  // Swapping the result again is a no-op rather than an arm-of-an-arm.
  assert.equal(worldWithVariant(out, 'lane', 'C').scene.states['lane']?.base, 'The lane, colder.')
})

test('an unknown label, an unknown state, or none at all returns the world untouched', () => {
  const w = world()
  assert.equal(worldWithVariant(w, 'lane', 'Z'), w, 'an arm nobody authored is not an empty arm')
  assert.equal(worldWithVariant(w, 'nowhere', 'B'), w)
  assert.equal(worldWithVariant(w, 'lane', null), w, 'no variant asked for is the authored world')
})
