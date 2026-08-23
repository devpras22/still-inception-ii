/**
 * The PRODUCER boundary.
 *
 * A dynamically-produced world — free-text creator skins, editor previews,
 * shared scenarios, an LLM narrator's output — is fail-closed: a doctrine
 * error in it is refused outright. Authored content stays advisory instead,
 * so it keeps its "play boots dirty, surface the diagnostics" behaviour.
 * This distinction already existed here as `origin: 'app' | 'agent'` on
 * every tool call, but was not being enforced on either side of it: the
 * agent wrote through the doctrine as freely as a person.
 *
 * The tests that matter are the two asymmetries — a machine may not introduce a
 * doctrine error, a person may; and a world that is ALREADY dirty stays
 * editable by the agent, or the correction round could never fix anything.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { LocalWorldStore } from '../../src/world/store/local'
import { fileStore, defaultStorePath } from '../../src/world/store/file.node'
import { runTool, root } from '../../src/tool'
import { runDoctrine } from '../../src/world/doctrine'
import { runLocalEdit } from '../../src/author/agent/edit'
import { directAction } from '../../src/play/director'
import type { PublicOp } from '../../src/world/api'

async function fresh() {
  const dir = mkdtempSync(join(tmpdir(), 'studio-boundary-'))
  const store = new LocalWorldStore(fileStore(defaultStorePath({ STUDIO_HOME: dir })))
  const created = await store.createWorld({ premise: 'a beaver exploring Atlantis' }, 'test')
  return { store, id: created.worldId ?? '', dir }
}

/** A base the doctrine rejects: negation in content prose — "NOT a rotor"
 *  summons a rotor. */
const NEGATED: PublicOp[] = [
  { op: 'add_state', id: 'dark_hall', base: 'A rear-view shot of a beaver in a hall where there is no light at all, the columns unlit.' },
]
const CLEAN: PublicOp[] = [
  { op: 'add_state', id: 'lit_hall', base: 'A rear-view shot of a beaver in a hall lit by a single shaft falling between the columns.' },
]

test('an AGENT batch that introduces a doctrine error is refused, and nothing is written', async () => {
  const { store, id, dir } = await fresh()
  try {
    const before = await store.getScene(id)
    await assert.rejects(
      () => store.applyOps(id, NEGATED, before.rev, { strict: true }),
      (e: unknown) => e instanceof Error && /doctrine rejected this batch/.test(e.message) && /negation/.test(e.message),
    )
    const after = await store.getScene(id)
    assert.equal(after.states['dark_hall'], undefined, 'the state never landed')
    assert.equal(after.rev, before.rev, 'and the world did not even move a revision')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('a PERSON writing the same thing is not stopped — authoring boots dirty', async () => {
  const { store, id, dir } = await fresh()
  try {
    const before = await store.getScene(id)
    const res = await store.applyOps(id, NEGATED, before.rev)
    assert.ok(res.rev)
    const after = await store.getScene(id)
    assert.ok(after.states['dark_hall'], 'it landed')
    // …and the diagnostic is still there to be read, which is the whole point
    // of advisory: told, not stopped.
    assert.ok(runDoctrine({ scene: { states: after.states, events: after.events } } as never).some((d) => d.lint === 'negation'))
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('a world that is ALREADY dirty stays editable by the agent', async () => {
  // Otherwise the correction round deadlocks: the model is handed an error it
  // cannot fix, because fixing it requires a write the gate refuses.
  const { store, id, dir } = await fresh()
  try {
    let rev = (await store.getScene(id)).rev
    await store.applyOps(id, NEGATED, rev) // a person made the mess
    rev = (await store.getScene(id)).rev

    const res = await store.applyOps(id, CLEAN, rev, { strict: true })
    assert.ok(res.rev, 'the agent may still work here')

    // And it can clean the mess up, too.
    rev = (await store.getScene(id)).rev
    await store.applyOps(
      id,
      [{ op: 'update_state', id: 'dark_hall', patch: { base: 'A rear-view shot of a beaver in an unlit hall, the columns black against a far green glow.' } }],
      rev,
      { strict: true },
    )
    const after = await store.getScene(id)
    assert.doesNotMatch(after.states['dark_hall']?.base ?? '', /no light/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('the boundary rides on ORIGIN: author.ops is strict for the agent, advisory for the app', async () => {
  const { store, id, dir } = await fresh()
  try {
    const asAgent = await runTool(root, 'author.ops', { world: id, ops: NEGATED }, { store, origin: 'agent', json: false })
    assert.equal(asAgent.ok, false, 'the agent is gated')
    assert.match(asAgent.ok ? '' : asAgent.error.message, /doctrine rejected this batch/)

    const asApp = await runTool(root, 'author.ops', { world: id, ops: NEGATED }, { store, origin: 'app', json: false })
    assert.equal(asApp.ok, true, 'the person is not')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('a clean agent batch is untouched by the gate', async () => {
  const { store, id, dir } = await fresh()
  try {
    const res = await runTool(root, 'author.ops', { world: id, ops: CLEAN }, { store, origin: 'agent', json: false })
    assert.equal(res.ok, true)
    const after = await store.getScene(id)
    assert.ok(after.states['lit_hall'])
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('THE WHOLE CHAIN: a model that violates the doctrine is handed its own error and fixes it', async () => {
  // The boundary is only worth having if it composes with the correction round:
  // refusing a machine's bad batch is half a feature if the machine is never
  // told what was wrong. This runs the real path — director →
  // runLocalEdit → author.ops (agent origin) → the gate → back to the model.
  const { store, id, dir } = await fresh()
  try {
    const asked: string[] = []
    const llm = {
      id: 'stub', label: 'stub', isConfigured: () => true,
      async complete(req: { messages: { role: string; content: string }[] }): Promise<string> {
        asked.push(req.messages.map((m) => m.content).join('\n'))
        return asked.length === 1
          ? JSON.stringify({ reply: 'the dark hall', ops: [
              { op: 'add_state', id: 'dark_hall', base: 'A rear-view shot of a beaver in a hall where there is no light at all, the columns unlit.' },
              { op: 'add_event', name: 'into_the_dark', kind: 'transition', from: ['opening'], to: 'dark_hall' },
            ] })
          : JSON.stringify({ reply: 'the unlit hall', ops: [
              { op: 'add_state', id: 'dark_hall', base: 'A rear-view shot of a beaver in an unlit hall, the columns black against a far green glow.' },
              { op: 'add_event', name: 'into_the_dark', kind: 'transition', from: ['opening'], to: 'dark_hall' },
            ] })
      },
    }
    const tools = {
      run: (path: string, input: Record<string, unknown>, opts?: { origin?: 'app' | 'agent' }) =>
        runTool(root, path, input, { store, origin: opts?.origin ?? 'app', json: false }),
    }

    const out = await directAction({
      text: 'the lights go out',
      ctx: { stateId: 'opening', stateIds: ['opening'], flags: new Set() },
      readScene: async () => {
        const sc = await store.getScene(id)
        return { states: sc.states, events: sc.events || [] }
      },
      kernel: async (instruction) => {
        const r = await runLocalEdit({ llm, store, tools, worldId: id, instruction, maxTokens: 16000 })
        return { reply: r.reply, applied: r.applied }
      },
    })

    assert.equal(asked.length, 2, 'the first answer was refused and it was asked again')
    assert.match(asked[1] ?? '', /doctrine rejected this batch/)
    assert.match(asked[1] ?? '', /negation/, 'the model is told WHICH rule it broke')
    assert.equal(out.ok, true)
    assert.deepEqual(out.play, [{ fire: 'into_the_dark' }], 'and the fixed version is what plays')

    const after = await store.getScene(id)
    assert.doesNotMatch(after.states['dark_hall']?.base ?? '', /no light/, 'the violating prose never reached the world')
    // Asked of the STORE, not of a world assembled here: a hand-built object
    // is missing the entrance and would fail for a reason this test is not about.
    // `ValidateResult` is a union whose other arm is "the check is unavailable";
    // the local store always runs it, so narrow rather than assume.
    const verdict = await store.validate(id)
    assert.equal(verdict.available, true)
    if (verdict.available) {
      assert.equal(verdict.ok, true, verdict.diagnostics.map((d) => d.lint).join(', '))
    }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
