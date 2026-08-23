/**
 * A console in the world.
 *
 * A persona and a truth ledger can be kept server-side, with the live flag set
 * passed each turn so the server decides what is sayable. There is no server
 * here, so the ledger is authored — and the property worth keeping is not the
 * architecture, it is this:
 *
 *   A FACT THE MODEL WAS NEVER TOLD IS A FACT IT CANNOT LEAK.
 *
 * Which is why these tests are mostly about what is ABSENT from the prompt.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { sayableFacts, terminalSystem } from '../../src/play/terminal'
import type { TerminalSpec } from '../../src/play/terminal'
import { LocalWorldStore } from '../../src/world/store/local'
import { fileStore, defaultStorePath } from '../../src/world/store/file.node'

const SPEC: TerminalSpec = {
  persona: 'You are STATION CONTROL, a maintenance terminal that has been alone for nine years.',
  greeting: 'STATION CONTROL — awaiting query.',
  facts: [
    { text: 'The reactor was shut down on day 412.' },
    { text: 'The crew left through the south lock.', requires: ['found_manifest'] },
    { text: 'Dr Aleksy stayed behind.', requires: ['found_manifest', 'read_log'] },
  ],
}

test('a gated fact is WITHHELD from the model, not marked secret inside the prompt', () => {
  const cold = terminalSystem(SPEC, new Set())
  assert.match(cold, /STATION CONTROL/)
  assert.match(cold, /reactor was shut down/)
  // The instruction "don't mention this" is one a model may fail to follow. A
  // sentence that is not in the context cannot be recited from it.
  assert.doesNotMatch(cold, /south lock/)
  assert.doesNotMatch(cold, /Aleksy/)

  const warmer = terminalSystem(SPEC, new Set(['found_manifest']))
  assert.match(warmer, /south lock/)
  assert.doesNotMatch(warmer, /Aleksy/, 'a fact needing TWO flags needs both')

  const open = terminalSystem(SPEC, new Set(['found_manifest', 'read_log']))
  assert.match(open, /Aleksy/)
})

test('the sayable set is exactly the unlocked facts', () => {
  assert.deepEqual(sayableFacts(SPEC, new Set()), ['The reactor was shut down on day 412.'])
  assert.equal(sayableFacts(SPEC, new Set(['found_manifest', 'read_log'])).length, 3)
  assert.deepEqual(sayableFacts({ persona: 'x' }, new Set()), [])
})

test('a console with nothing unlocked still has a voice, and stays in character', () => {
  const bare = terminalSystem({ persona: 'You are a door.' }, new Set())
  assert.match(bare, /You know nothing beyond your own function/)
  assert.match(bare, /do not explain\s*\n?that you are a language model/)
  assert.match(bare, /You are a terminal in a room/)
})

test('the store keeps a terminal, and refuses a malformed ledger', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'studio-term-'))
  try {
    const store = new LocalWorldStore(fileStore(defaultStorePath({ STUDIO_HOME: dir })))
    const created = await store.createWorld({ template: 'starter' }, 'k')
    const id = created.worldId ?? ''
    const rev = (await store.getScene(id)).rev

    await store.applyOps(id, [{
      op: 'add_event', name: 'use_console', kind: 'terminal', from: ['lane'],
      terminal: { persona: 'You are a door.', facts: [{ text: 'It is locked.', requires: ['has_key'] }] },
    }], rev)
    const ev = (await store.getScene(id)).events.find((e) => e.name === 'use_console')
    assert.equal(ev?.terminal?.persona, 'You are a door.')
    assert.deepEqual(ev?.terminal?.facts?.[0]?.requires, ['has_key'])

    // A fact with no text would be silently unsayable — the one kind of quiet a
    // truth ledger cannot afford.
    const rev2 = (await store.getScene(id)).rev
    await assert.rejects(
      () => store.applyOps(id, [{
        op: 'add_event', name: 'bad', kind: 'terminal', from: ['lane'],
        terminal: { persona: 'x', facts: [{ requires: ['a'] }] },
      }], rev2),
      /"terminal" must be/,
    )
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
