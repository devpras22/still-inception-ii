/**
 * Authored structure that references a graph which has moved on.
 *
 * Both rules here police the same failure: a thing above the graph — a
 * set-piece, a quest — still naming something the graph no longer has. Neither
 * is caught at write time, because both were VALID when written; what changed
 * afterwards was the graph. That is exactly the class a player discovers and an
 * author does not.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { runDoctrine } from '../../src/world/doctrine'
import { lintTitle } from '../../src/world/lintHelp'
import { LocalWorldStore } from '../../src/world/store/local'
import { fileStore, defaultStorePath } from '../../src/world/store/file.node'
import { unwrapWorldDoc } from '../../src/world'
import type { SMWorld } from '../../src/world'

function world(extra: Partial<SMWorld> = {}): SMWorld {
  return {
    entrance: { state: 'a' },
    scene: {
      states: {
        a: { base: 'A rear-view shot of a diver in a flooded atrium, columns rising into green light.' },
        b: { base: 'A rear-view shot of a diver in a drowned plaza, statues leaning in the current.' },
      },
      events: [{ name: 'go', kind: 'transition', from: ['a'], to: 'b' }],
    },
    ...extra,
  } as unknown as SMWorld
}

test('a set-piece walking into a deleted state is an ERROR, named by beat', () => {
  const ok = world({ sequences: [{ id: 's1', title: 'The gate opens', beats: [{ state: 'a' }, { state: 'b' }] }] })
  assert.deepEqual(runDoctrine(ok).filter((d) => d.lint === 'sequence-beat-missing'), [])

  const rotted = world({ sequences: [{ id: 's1', title: 'The gate opens', beats: [{ state: 'a' }, { state: 'gone' }] }] })
  const hits = runDoctrine(rotted).filter((d) => d.lint === 'sequence-beat-missing')
  assert.equal(hits.length, 1)
  assert.equal(hits[0]?.severity, 'error')
  assert.equal(hits[0]?.path, 'sequences.s1.beats[1]')
  assert.match(hits[0]?.message ?? '', /walks into "gone"/)
  assert.match(lintTitle('sequence-beat-missing'), /set-piece/i)
})

test('an objective whose flag nothing grants is an ERROR — the quest is unwinnable', () => {
  const granted = world({
    scene: {
      states: world().scene.states,
      events: [{ name: 'go', kind: 'transition', from: ['a'], to: 'b', grants: ['found_it'] }],
    },
    missions: [{ id: 'm', title: 'The Search', objectives: [{ id: 'found_it', text: 'Find the helmet' }] }],
  } as Partial<SMWorld>)
  assert.deepEqual(runDoctrine(granted).filter((d) => d.lint === 'objective-unreachable'), [])

  const orphaned = world({
    missions: [{ id: 'm', title: 'The Search', objectives: [{ id: 'found_it', text: 'Find the helmet' }] }],
  })
  const hits = runDoctrine(orphaned).filter((d) => d.lint === 'objective-unreachable')
  assert.equal(hits.length, 1)
  assert.equal(hits[0]?.severity, 'error')
  assert.match(hits[0]?.message ?? '', /can never be finished/)

  // An objective may name its own flag explicitly; the rule follows that too.
  const explicit = world({
    scene: {
      states: world().scene.states,
      events: [{ name: 'go', kind: 'transition', from: ['a'], to: 'b', grants: ['has_key'] }],
    },
    missions: [{ id: 'm', title: 'x', objectives: [{ id: 'step', text: 'Take the key', grants: 'has_key' }] }],
  } as Partial<SMWorld>)
  assert.deepEqual(runDoctrine(explicit).filter((d) => d.lint === 'objective-unreachable'), [])
})

test('deleting a state SAYS which set-pieces it broke, and does not silently repair them', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'studio-rot-'))
  try {
    const store = new LocalWorldStore(fileStore(defaultStorePath({ STUDIO_HOME: dir })))
    const created = await store.createWorld({ template: 'starter' }, 'k')
    const id = created.worldId ?? ''
    let rev = (await store.getScene(id)).rev
    await store.applyOps(id, [{
      op: 'add_sequence', id: 'arrival', title: 'The gate opens',
      beats: [{ state: 'lane' }, { state: 'orchard_gate' }],
    }], rev)

    rev = (await store.getScene(id)).rev
    const res = await store.applyOps(id, [{ op: 'delete_state', id: 'orchard_gate' }], rev)
    const said = (res.diagnostics ?? []).find((d) => d.lint === 'store/sequence-beat')
    assert.ok(said, 'the write reported it')
    assert.match(said?.message ?? '', /The gate opens/)

    // The beat is STILL THERE — pacing is the author's, and a silent prune
    // would rewrite it to hide their own edit.
    const after = unwrapWorldDoc(await store.getWorld(id))
    assert.equal(after.sequences?.[0]?.beats.length, 2)
    // …and the doctrine now reports the rot, so it is visible in the panel.
    assert.ok(runDoctrine(after).some((d) => d.lint === 'sequence-beat-missing'))
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('the story survives the store, and a beat never unhappens', async () => {
  // `set_story` replaces the premise and KEEPS the beats: rewriting what a
  // world is about does not unhappen what already occurred in it.
  const dir = mkdtempSync(join(tmpdir(), 'studio-story-'))
  try {
    const store = new LocalWorldStore(fileStore(defaultStorePath({ STUDIO_HOME: dir })))
    const created = await store.createWorld({ template: 'starter' }, 'k')
    const id = created.worldId ?? ''
    let rev = (await store.getScene(id)).rev

    await store.applyOps(id, [
      { op: 'set_story', logline: 'A walk that goes wrong.', arc: ['arrival', 'unease'] },
      { op: 'add_story_beat', summary: 'the gate opened by itself', states: ['orchard_gate'] },
    ], rev)
    let world = unwrapWorldDoc(await store.getWorld(id))
    assert.equal(world.story?.logline, 'A walk that goes wrong.')
    assert.deepEqual(world.story?.arc, ['arrival', 'unease'])
    assert.equal(world.story?.beats?.length, 1)
    assert.deepEqual(world.story?.beats?.[0]?.states, ['orchard_gate'])

    rev = (await store.getScene(id)).rev
    await store.applyOps(id, [{ op: 'set_story', logline: 'Actually a comedy.' }], rev)
    world = unwrapWorldDoc(await store.getWorld(id))
    assert.equal(world.story?.logline, 'Actually a comedy.')
    assert.equal(world.story?.beats?.length, 1, 'the beat is still there')
    assert.equal(world.story?.arc, undefined, 'but the arc was replaced, as asked')

    // A beat on a world with no story yet is kept rather than refused: losing
    // the record of an action because nobody wrote a logline first is the wrong
    // thing to be strict about.
    const fresh = await store.createWorld({ template: 'starter' }, 'k2')
    const fid = fresh.worldId ?? ''
    await store.applyOps(fid, [{ op: 'add_story_beat', summary: 'something happened' }], (await store.getScene(fid)).rev)
    assert.equal(unwrapWorldDoc(await store.getWorld(fid)).story?.beats?.length, 1)

    const frev = (await store.getScene(fid)).rev
    await assert.rejects(
      () => store.applyOps(fid, [{ op: 'add_story_beat', summary: '  ' }], frev),
      /needs a "summary"/,
    )
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
