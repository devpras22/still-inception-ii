/**
 * A line to READ, derived from a line written to be RENDERED.
 *
 * The derivation is a STRIP, not a summary: a base opens with a camera
 * instruction and may close with a style tail, and both are addressed to a
 * diffusion model rather than to a person. What these tests pin is that it
 * never overrides an author, and that it declines rather than guesses.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { deriveNarration, narrationFor } from '../../src/play/narrate'
import type { SMState, SMWorld } from '../../src/world'

const world = (extra: Partial<SMWorld> = {}): SMWorld => ({ scene: { states: {}, events: [] }, ...extra } as SMWorld)
const state = (base: string, narration?: string): SMState => ({ base, ...(narration ? { narration } : {}) } as SMState)

test('the camera preamble comes off, in each form this studio writes', () => {
  assert.equal(
    deriveNarration(world(), state('A third-person rear-view shot of a beaver at the gates of a sunken city.')),
    'A beaver at the gates of a sunken city.',
  )
  assert.equal(
    deriveNarration(world(), state('A rear-view shot of a walker on a rutted lane under heavy snow')),
    'A walker on a rutted lane under heavy snow.',
  )
  // An earlier form, kept so a world authored against it still reads.
  assert.equal(
    deriveNarration(world(), state('A diver, seen from behind, drifting over a black trench')),
    'Drifting over a black trench.',
  )
})

test('the style tail comes off too — it is a lock for the model, not a sentence', () => {
  const w = world({ styleTail: 'shot on 35mm, heavy grain' })
  assert.equal(
    deriveNarration(w, state('A rear-view shot of a hall of columns. shot on 35mm, heavy grain')),
    'A hall of columns.',
  )
})

test('it DECLINES rather than guessing', () => {
  assert.equal(deriveNarration(world(), state('')), undefined)
  assert.equal(deriveNarration(world(), undefined), undefined)
  // Nothing left after the strip is not a narration.
  assert.equal(deriveNarration(world(), state('A rear-view shot of a')), undefined)
})

test('an AUTHORED narration always wins, and the flag gates the fallback', () => {
  const s = state('A rear-view shot of a hall of columns.', 'The hall is colder than it looks.')
  // Authored wins whether or not the world opted in.
  assert.equal(narrationFor(world(), s), 'The hall is colder than it looks.')
  assert.equal(narrationFor(world({ narrate: true }), s), 'The hall is colder than it looks.')

  // Without narration: nothing unless the world asked for it. A hand-authored
  // world shows only what its author wrote.
  const bare = state('A rear-view shot of a hall of columns.')
  assert.equal(narrationFor(world(), bare), undefined)
  assert.equal(narrationFor(world({ narrate: true }), bare), 'A hall of columns.')
})
