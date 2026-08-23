/**
 * AlakazamClient's wire boundary, pinned.
 *
 * Every hosted /v1 response used to land as `return json as T` — an unverified
 * claim about the network. This file feeds the client a stubbed `fetch` and
 * proves the two halves of the replacement: a well-formed response still comes
 * back typed and usable, and a malformed one throws an ApiError-shaped error
 * whose `detail` NAMES what lied, rather than handing a caller a silent
 * `undefined` three components downstream.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'

import { AlakazamClient } from '../../src/world/api'

/** Swap `globalThis.fetch` for a canned response and return a restorer. Only
 *  the members `req()` actually reads (`ok`, `status`, `text()`) are real. */
function stubFetch(status: number, body: unknown): () => void {
  const original = globalThis.fetch
  const ok = status >= 200 && status < 300
  const fake = (async () => ({ ok, status, text: async () => JSON.stringify(body) })) as unknown as typeof fetch
  globalThis.fetch = fake
  return () => { globalThis.fetch = original }
}

function client(): AlakazamClient {
  return new AlakazamClient({ baseUrl: 'https://example.test', apiKey: 'sk_test' })
}

test('a well-formed scene comes back typed and usable', async () => {
  const restore = stubFetch(200, { states: { start: { base: 'A shore.' } }, events: [], rev: 'r1' })
  try {
    const scene = await client().getScene('w1')
    assert.equal(scene.rev, 'r1')
    assert.equal(scene.states['start']?.base, 'A shore.')
    assert.deepEqual(scene.events, [])
  } finally {
    restore()
  }
})

test('a scene missing rev throws an ApiError naming the malformation', async () => {
  const restore = stubFetch(200, { states: {}, events: [] })
  try {
    await assert.rejects(
      () => client().getScene('w1'),
      (e: unknown) => {
        assert.ok(e instanceof Error)
        const err = e as unknown as { status: number; detail: string }
        assert.equal(err.status, 502)
        assert.match(err.detail, /scene/)
        assert.match(err.detail, /rev/)
        return true
      },
    )
  } finally {
    restore()
  }
})

test('a non-object body throws an ApiError instead of a downstream crash', async () => {
  const restore = stubFetch(200, ['not', 'an', 'object'])
  try {
    await assert.rejects(
      () => client().getScene('w1'),
      (e: unknown) => {
        const err = e as unknown as { status: number; detail: string }
        assert.equal(err.status, 502)
        assert.match(err.detail, /not an object/)
        return true
      },
    )
  } finally {
    restore()
  }
})

test('an HTTP error surfaces its detail and diagnostics unchanged', async () => {
  const restore = stubFetch(422, { detail: 'invalid world', diagnostics: [{ lint: 'no-orphans', severity: 'error', path: 'states.x', message: 'unreachable' }] })
  try {
    await assert.rejects(
      () => client().getScene('w1'),
      (e: unknown) => {
        const err = e as unknown as { status: number; detail: string; diagnostics?: unknown[] }
        assert.equal(err.status, 422)
        assert.equal(err.detail, 'invalid world')
        assert.equal(err.diagnostics?.length, 1)
        return true
      },
    )
  } finally {
    restore()
  }
})

test('a graph write missing its world object throws naming the endpoint', async () => {
  const restore = stubFetch(200, { rev: 'r2' })
  try {
    await assert.rejects(
      () => client().addState('w1', { base: 'A pier.' }),
      (e: unknown) => {
        const err = e as unknown as { status: number; detail: string }
        assert.equal(err.status, 502)
        assert.match(err.detail, /states/)
        assert.match(err.detail, /world/)
        return true
      },
    )
  } finally {
    restore()
  }
})

test('a graph write with a world record narrows it and keeps the rev', async () => {
  const restore = stubFetch(200, { world: { name: 'Test' }, rev: 'r3' })
  try {
    const res = await client().addState('w1', { base: 'A pier.' })
    assert.equal(res.rev, 'r3')
    assert.equal(res.world.name, 'Test')
    // The nested scene is trusted loosely (not sent by the server here) — it
    // still comes back as a genuine, empty SMScene rather than undefined.
    assert.deepEqual(res.world.scene, { states: {}, events: [] })
  } finally {
    restore()
  }
})
