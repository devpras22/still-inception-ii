/**
 * The fine-grained op vocabulary, proved through the store.
 *
 * The store shipped with coarse ops only — `update_state`/`update_event` taking
 * a patch of anything. The narrow ops split the same work into one op per
 * concern, and are the better vocabulary for the writer that actually uses
 * them: they are emitted by a language model, and a three-field op is a shape
 * a model gets right far more often than a free-form patch.
 *
 * Every test here WRITES through the op and then READS the world back, because
 * a field the schema carries and the store silently drops is invisible —
 * `add_event` ate anchor/requires/grants for months while every assertion on
 * the op object passed. Asserting the returned diagnostics,
 * or the op that was sent, would reproduce exactly that blindness. So: read the
 * stored world, or it is not a test.
 *
 * The two ops that are NOT translations of an existing coarse one —
 * `rename_state` and `set_variant_field` — carry the most tests, because they
 * are new behaviour rather than a new spelling.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { LocalWorldStore } from '../../src/world/store/local'
import { fileStore, defaultStorePath } from '../../src/world/store/file.node'
import { PUBLIC_OPS } from '../../src/world'
import { runLocalEdit } from '../../src/author/agent/edit'
import { runTool, root } from '../../src/tool'
import type { PublicOp } from '../../src/world'
import type { SMWorld } from '../../src/world'

async function fresh() {
  const dir = mkdtempSync(join(tmpdir(), 'studio-fineops-'))
  const store = new LocalWorldStore(fileStore(defaultStorePath({ STUDIO_HOME: dir })))
  const created = await store.createWorld({ premise: 'a beaver exploring Atlantis' }, 'test')
  const id = created.worldId ?? ''
  // No ifMatch: these tests are single-writer, and threading a rev through
  // every call would test optimistic concurrency (rev-contract.test.ts already
  // does) instead of the ops.
  const apply = async (...ops: Record<string, unknown>[]): Promise<void> => {
    await store.applyOps(id, ops as PublicOp[])
  }
  // getWorld returns the world FLAT — the document IS the world, with id/name
  // spread onto it — so there is no `.world` to reach through.
  const read = async (): Promise<SMWorld> => await store.getWorld(id)
  return { store, id, dir, apply, read }
}

/** A named state that definitely exists, plus one event leading to it. */
async function seeded() {
  const f = await fresh()
  await f.apply(
    { op: 'add_state', id: 'lamp_room', base: 'A drowned lamp room, green light.' },
    { op: 'add_transition', from: 'opening', to: 'lamp_room', name: 'swim_down' },
  )
  return f
}

test('every fine-grained op the store implements is in the public vocabulary', () => {
  // The one deliberate absence is `set_slot_fill` (factored fields are MISSING
  // by choice). This pins the list so the vocabulary cannot shrink unnoticed.
  const fine = [
    'set_field', 'set_event_field', 'add_transition', 'add_override', 'rename_state',
    'remove_state', 'remove_event', 'set_state_ending', 'set_event_kind', 'set_event_drive',
    'set_event_hotkey', 'set_event_phases', 'set_event_anchor', 'set_event_grants',
    'set_event_requires', 'set_event_locked_hint', 'set_variant_field', 'set_subject',
  ]
  const missing = fine.filter((op) => !(PUBLIC_OPS as readonly string[]).includes(op))
  assert.deepEqual(missing, [], 'ops declared but not published')
})

test('set_field writes ONE field and leaves its sibling alone', async () => {
  const { dir, apply, read } = await fresh()
  try {
    await apply({ op: 'set_field', state: 'opening', field: 'camera.static', value: 'low, looking up' })
    await apply({ op: 'set_field', state: 'opening', field: 'camera.dynamic', value: 'slow push in' })
    const st = (await read()).scene.states['opening']
    assert.equal(st?.camera?.static, 'low, looking up')
    // The whole point of a per-field op: the second write must not erase the
    // first. A replace-not-merge implementation passes every other assertion
    // in this file and fails this one.
    assert.equal(st?.camera?.dynamic, 'slow push in')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('set_field refuses a field name outside the flat vocabulary', async () => {
  const { dir, apply } = await fresh()
  try {
    await assert.rejects(
      () => apply({ op: 'set_field', state: 'opening', field: 'camera.sideways', value: 'x' }),
      /field/,
    )
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('the event ops each land their own slot, read back off the world', async () => {
  const { dir, apply, read } = await seeded()
  try {
    await apply(
      { op: 'set_event_field', event: 'swim_down', field: 'base', value: 'The beaver kicks down past a broken column.' },
      { op: 'set_event_anchor', event: 'swim_down', label: 'broken column', aliases: ['column'], minProximity: 0.3 },
      { op: 'set_event_grants', event: 'swim_down', grants: ['saw_the_lamp'] },
      { op: 'set_event_requires', event: 'swim_down', requires: ['has_torch'] },
      { op: 'set_event_locked_hint', event: 'swim_down', hint: 'You would need a light.' },
      { op: 'set_event_hotkey', event: 'swim_down', hotkey: 'j' },
      { op: 'set_event_drive', event: 'swim_down', movement: 'forward', lookVertical: 'down', pulseMs: 900 },
    )
    const ev = (await read()).scene.events.find((e) => e.name === 'swim_down')
    assert.ok(ev, 'the event survived')
    assert.match(ev.base ?? '', /broken column/)
    assert.equal(ev.anchor?.label, 'broken column')
    assert.deepEqual(ev.anchor?.aliases, ['column'])
    assert.equal(ev.anchor?.minProximity, 0.3)
    assert.deepEqual(ev.grants, ['saw_the_lamp'])
    assert.deepEqual(ev.requires, ['has_torch'])
    assert.equal(ev.lockedHint, 'You would need a light.')
    assert.equal(ev.hotkey, 'j')
    assert.equal(ev.drive?.movement, 'forward')
    assert.equal(ev.drive?.lookVertical, 'down')
    // The pulse could be carried on the drive op instead; the store keeps it
    // on the event, and that translation is exactly where a field goes missing.
    assert.equal(ev.drivePulseMs, 900)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('add_override makes an override, and does not give it a destination', async () => {
  const { dir, apply, read } = await fresh()
  try {
    // `to` is passed and must be IGNORED: an override returns to the state it
    // fired from, and one carrying a destination trips the doctrine.
    await apply({ op: 'add_override', from: 'opening', name: 'look_up', base: 'The beaver tips its head back.', to: 'opening' })
    const ev = (await read()).scene.events.find((e) => e.name === 'look_up')
    assert.equal(ev?.kind, 'override')
    assert.equal(ev?.to, undefined, 'an override carries no destination')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('set_state_ending sets an ending, and clears it again', async () => {
  const { dir, apply, read } = await seeded()
  try {
    await apply({ op: 'set_state_ending', state: 'lamp_room', kind: 'win', title: 'The lamp still burns', subtitle: 'after all this water' })
    let st = (await read()).scene.states['lamp_room']
    assert.equal(st?.ending?.kind, 'win')
    assert.equal(st?.ending?.subtitle, 'after all this water')
    await apply({ op: 'set_state_ending', state: 'lamp_room', kind: null })
    st = (await read()).scene.states['lamp_room']
    assert.equal(st?.ending, undefined, 'the op that sets it is the op that clears it')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('rename_state carries EVERY reference with it', async () => {
  const { dir, apply, read } = await seeded()
  try {
    await apply(
      { op: 'set_entrance', state: 'lamp_room' },
      { op: 'add_sequence', id: 'descent', title: 'Down', beats: [{ state: 'lamp_room', base: 'The lamp.' }] },
      { op: 'set_story', logline: 'A beaver looting a sunken city.' },
      { op: 'add_story_beat', summary: 'It finds the lamp.', states: ['lamp_room'] },
    )
    await apply({ op: 'rename_state', from: 'lamp_room', to: 'lamp_chamber' })

    const w = await read()
    assert.ok(w.scene.states['lamp_chamber'], 'the state moved to its new id')
    assert.equal(w.scene.states['lamp_room'], undefined, 'and left nothing behind')
    const ev = w.scene.events.find((e) => e.name === 'swim_down')
    assert.equal(ev?.to, 'lamp_chamber', 'the transition follows')
    assert.equal(w.entrance?.state, 'lamp_chamber', 'the entrance follows')
    assert.equal(w.sequences?.[0]?.beats[0]?.state, 'lamp_chamber', 'the set-piece beat follows')
    assert.deepEqual(w.story?.beats?.[0]?.states, ['lamp_chamber'], 'the story beat follows')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('rename_state is a REKEY, not the delete cascade', async () => {
  const { dir, apply, read } = await seeded()
  try {
    const before = (await read()).scene.events.length
    await apply({ op: 'rename_state', from: 'lamp_room', to: 'lamp_chamber' })
    const w = await read()
    // Deleting `lamp_room` would strip it from every `from`, then delete any
    // event left sourceless. If rename were implemented as delete-and-re-add,
    // this count would drop and the author's graph would quietly lose edges.
    assert.equal(w.scene.events.length, before, 'no event was collateral')
    assert.ok(
      w.scene.events.every((e) => !e.from.includes('lamp_room') && e.to !== 'lamp_room'),
      'nothing still points at the old id',
    )
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('rename_state refuses a collision and an empty id', async () => {
  const { dir, apply, read } = await seeded()
  try {
    await assert.rejects(() => apply({ op: 'rename_state', from: 'lamp_room', to: 'opening' }), /already exists/)
    await assert.rejects(() => apply({ op: 'rename_state', from: 'lamp_room', to: '   ' }), /cannot be empty/)
    // A refused rename must leave the graph exactly as it was.
    assert.ok((await read()).scene.states['lamp_room'], 'the state is untouched')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('set_variant_field edits the arm IN PLACE, keeping its label addressable', async () => {
  const { dir, apply, read } = await fresh()
  try {
    await apply(
      { op: 'add_variant', state: 'opening', variant: { label: 'B', base: 'The same gate at night.' } },
      { op: 'add_variant', state: 'opening', variant: { label: 'C', base: 'The same gate in fog.' } },
    )
    await apply({ op: 'set_variant_field', state: 'opening', label: 'B', field: 'camera.static', value: 'wide, from the silt' })

    const variants = (await read()).scene.states['opening']?.variants ?? []
    const b = variants.find((v) => v.label === 'B')
    assert.equal(b?.camera?.static, 'wide, from the silt')
    assert.match(b?.base ?? '', /at night/, 'the arm kept its own prose')
    // The player addresses an arm by `?variant=<label>`, so a remove-and-re-add
    // implementation would break every link to it and reorder the list.
    assert.deepEqual(variants.map((v) => v.label), ['B', 'C'], 'the arms kept their order')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('set_variant_field refuses an arm that is not there', async () => {
  const { dir, apply } = await fresh()
  try {
    await assert.rejects(
      () => apply({ op: 'set_variant_field', state: 'opening', label: 'Z', field: 'base', value: 'x' }),
      /no variant labelled/,
    )
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('set_subject writes the subject lock through the op vocabulary', async () => {
  const { dir, apply, read } = await fresh()
  try {
    await apply({ op: 'set_subject', subject: 'a beaver in a brass diving helmet', styleTail: 'muted, filmic' })
    const w = await read()
    assert.equal(w.subject, 'a beaver in a brass diving helmet')
    assert.equal(w.styleTail, 'muted, filmic')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('an unknown op names the vocabulary it could have used', async () => {
  const { dir, apply } = await fresh()
  try {
    // The message used to list nine ops while the store applied nineteen,
    // because the list was written by hand beside the switch.
    await assert.rejects(
      () => apply({ op: 'set_event_colour', event: 'x', value: 'y' }),
      (e: Error) => /set_event_anchor/.test(e.message) && /rename_state/.test(e.message),
    )
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

/**
 * The CORRECTION ROUND.
 *
 * Found by measurement, not by reading: a 54-trial live sweep of the whole fine
 * vocabulary landed 51/54, and TWO of the three misses were the same
 * self-inflicted wound. Asked only for a locked hint, the model helpfully also
 * set `requires: ['has_light']` — a flag nothing grants — so the doctrine's
 * `unreachable-require` refused the batch WHOLE (an agent-origin write is
 * all-or-nothing) and the hint the author actually asked for was lost with it.
 * The author saw nothing happen and was told nothing.
 *
 * The director already had this; the editor agent had not. It is a better fix
 * than naming the rule in the prompt because it covers every doctrine rule
 * rather than the one that happened to bite.
 */
test('a refused batch comes BACK to the model, and the second answer lands', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'studio-correct-'))
  try {
    const store = new LocalWorldStore(fileStore(defaultStorePath({ STUDIO_HOME: dir })))
    const created = await store.createWorld({ premise: 'a beaver exploring Atlantis' }, 'test')
    const id = created.worldId ?? ''
    await store.applyOps(id, [
      { op: 'add_state', id: 'temple_atrium', base: 'A flooded atrium of broken columns.' },
      { op: 'add_transition', from: 'opening', to: 'temple_atrium', name: 'enter_arch' },
    ] as PublicOp[])

    const seen: string[] = []
    const answers = [
      // Round 1: exactly the live failure — the hint, plus a require nothing grants.
      JSON.stringify({
        reply: 'Locked it behind a light.',
        ops: [
          { op: 'set_event_requires', event: 'enter_arch', requires: ['has_light'] },
          { op: 'set_event_locked_hint', event: 'enter_arch', hint: 'You would need a light.' },
        ],
      }),
      // Round 2: what a model does once it is told why.
      JSON.stringify({
        reply: 'Just the hint, then.',
        ops: [{ op: 'set_event_locked_hint', event: 'enter_arch', hint: 'You would need a light.' }],
      }),
    ]
    const llm = {
      id: 'stub',
      label: 'stub',
      isConfigured: () => true,
      async complete(req: { messages: { role: string; content: string }[] }): Promise<string> {
        seen.push(req.messages[req.messages.length - 1]?.content ?? '')
        return answers[Math.min(seen.length - 1, answers.length - 1)] ?? ''
      },
    }
    const tools = {
      run: (path: string, input: Record<string, unknown>, o?: { origin?: 'app' | 'agent' }) =>
        runTool(root, path, input, { store, origin: o?.origin ?? 'app', json: false }),
    }

    const out = await runLocalEdit({ llm: llm as never, store, tools, worldId: id, instruction: 'lock the arch behind a light' })

    assert.equal(seen.length, 2, 'the model was asked again')
    assert.match(seen[1] ?? '', /REFUSED/, 'and was told its answer was refused')
    assert.match(seen[1] ?? '', /unreachable-require/, 'quoting the rule that stopped it, not a generic apology')
    assert.equal(out.applied, 1)

    const ev = (await store.getWorld(id)).scene.events.find((e) => e.name === 'enter_arch')
    assert.equal(ev?.lockedHint, 'You would need a light.', 'the hint the author asked for is in the world')
    assert.equal(ev?.requires, undefined, 'and the flag that caused the refusal is not')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
