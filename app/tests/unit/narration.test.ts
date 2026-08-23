/**
 * NARRATION — the only prose in a world that is not a prompt.
 *
 * `base`, `camera`, `movement` and `ambient` are instructions to a world model,
 * which never shows them verbatim. Narration is display copy shown beside the
 * picture, and the doctrine is explicit that it is "ignored by the
 * world-model runtime and NOT checked by the lint suite".
 *
 * That exemption is the whole reason the field exists separately, so it is what
 * these tests are mostly about: the same sentence must be an ERROR in a base
 * and fine in narration, and must not be charged against the prompt budget.
 * Both would otherwise be rules aimed at the wrong reader.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { LocalWorldStore } from '../../src/world/store/local'
import { fileStore, defaultStorePath } from '../../src/world/store/file.node'
import { runDoctrine, PROMPT_BUDGET } from '../../src/world/doctrine'
import { promptForBeat } from '../../src/play/episode'
import type { SMWorld } from '../../src/world/api'

function worldWith(state: Record<string, unknown>): SMWorld {
  return {
    entrance: { state: 'a' },
    scene: {
      states: { a: { base: 'A rear-view shot of a diver in a flooded atrium, columns rising into green light.', ...state } },
      events: [],
    },
  } as unknown as SMWorld
}

test('a negation is an ERROR in a base and FINE in narration', () => {
  const inBase = runDoctrine(worldWith({ base: 'A hall where there is no light at all.' }))
  assert.ok(inBase.some((d) => d.lint === 'negation' && d.severity === 'error'))

  const inNarration = runDoctrine(worldWith({ narration: 'There is no way back from here.' }))
  assert.deepEqual(inNarration.filter((d) => d.lint === 'negation'), [], 'a person reads this; a model never does')
})

test('narration is not charged against the prompt budget', () => {
  const long = 'x'.repeat(PROMPT_BUDGET * 2)
  const diags = runDoctrine(worldWith({ narration: long }))
  assert.deepEqual(diags.filter((d) => d.lint === 'budget'), [], 'nothing streams it, so it costs nothing')

  // …and the budget still bites on prose that IS streamed, so the exemption is
  // narrow rather than a hole.
  assert.ok(runDoctrine(worldWith({ base: long })).some((d) => d.lint === 'budget'))
})

test('narration and arriveLabel survive the store, and null erases them', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'studio-narr-'))
  try {
    const store = new LocalWorldStore(fileStore(defaultStorePath({ STUDIO_HOME: dir })))
    const created = await store.createWorld({ template: 'starter' }, 'k')
    const id = created.worldId ?? ''

    let rev = (await store.getScene(id)).rev
    await store.applyOps(id, [
      { op: 'update_state', id: 'lane', patch: { narration: 'The lane is quiet.', arriveLabel: 'the rutted lane' } },
      { op: 'update_event', name: 'walk_up_the_lane', patch: { narration: 'You push on up the hill.' } },
    ], rev)

    let scene = await store.getScene(id)
    assert.equal(scene.states['lane']?.narration, 'The lane is quiet.')
    assert.equal(scene.states['lane']?.arriveLabel, 'the rutted lane')
    assert.equal(scene.events.find((e) => e.name === 'walk_up_the_lane')?.narration, 'You push on up the hill.')

    rev = scene.rev
    await store.applyOps(id, [{ op: 'update_state', id: 'lane', patch: { narration: null } }], rev)
    scene = await store.getScene(id)
    assert.equal(scene.states['lane']?.narration, undefined)
    assert.equal(scene.states['lane']?.arriveLabel, 'the rutted lane', 'and erasing one did not take the other')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('a non-string narration is refused at the boundary', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'studio-narr2-'))
  try {
    const store = new LocalWorldStore(fileStore(defaultStorePath({ STUDIO_HOME: dir })))
    const created = await store.createWorld({ template: 'starter' }, 'k')
    const id = created.worldId ?? ''
    const rev = (await store.getScene(id)).rev
    await assert.rejects(
      () => store.applyOps(id, [{ op: 'update_state', id: 'lane', patch: { narration: 12 } }], rev),
      /"narration" must be a string/,
    )
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('the beat a player sends carries its framing and NOT its narration', () => {
  // This is the claim the e2e cannot make. The mock world model wraps its
  // prompt to three lines, so "the narration is not on screen" is equally
  // consistent with "it was sent and clipped" — the assertion has to be made
  // where the value is, not where the pixels are.
  const sent = promptForBeat({
    text: 'Walking on up the rutted lane.',
    camera: 'low and close, following through the gap',
    movement: 'striding forward',
    narration: 'You push through the gap and the orchard opens out.',
  })
  assert.equal(sent, 'Walking on up the rutted lane. low and close, following through the gap striding forward')
  assert.doesNotMatch(sent, /orchard opens out/)
  assert.equal(promptForBeat({ text: 'Just the prose.' }), 'Just the prose.')
})
