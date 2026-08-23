/**
 * MoondreamVisionProvider's wire boundary, pinned — the same discipline
 * api-narrow.test.ts applies to AlakazamClient: a stubbed `fetch` proves a
 * well-formed response comes back typed and usable, a malformed one throws
 * rather than handing a caller silent junk, and isConfigured() is false out
 * of the box — the fact that keeps a fresh clone from calling out to anyone.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'

import { createMoondreamVisionProvider } from '../../src/provider/vision/moondream'
import { VisionError } from '../../src/provider/types'

/** Swap `globalThis.fetch` for a canned response and return a restorer, same
 *  shape as api-narrow.test.ts's stubFetch. `calls` collects every request so
 *  a test can assert on the URL/headers/body it actually sent. */
function stubFetch(status: number, body: unknown): { restore: () => void; calls: { url: string; init: RequestInit }[] } {
  const original = globalThis.fetch
  const ok = status >= 200 && status < 300
  const calls: { url: string; init: RequestInit }[] = []
  const fake = (async (url: string, init: RequestInit) => {
    calls.push({ url: String(url), init: (init ?? {}) })
    return { ok, status, text: async () => JSON.stringify(body) }
  }) as unknown as typeof fetch
  globalThis.fetch = fake
  return { restore: () => { globalThis.fetch = original }, calls }
}

function cloudProvider(apiKey = 'sk-test-key') {
  return createMoondreamVisionProvider({ endpoint: 'cloud', apiKey, localUrl: '' })
}

function localProvider(localUrl = 'http://localhost:2020/v1/detect') {
  return createMoondreamVisionProvider({ endpoint: 'local', apiKey: '', localUrl })
}

/** node:assert's `rejects` predicate wants a boolean; this both narrows and
 *  asserts in one place so every test below reads the same way. */
function isVisionError(e: unknown): e is VisionError {
  return e instanceof VisionError
}

function headerRecord(init: RequestInit): Record<string, string> {
  const h = init.headers
  return h && typeof h === 'object' && !Array.isArray(h) ? (h as Record<string, string>) : {}
}

test('isConfigured() is false out of the box — this is what keeps the keyless promise', () => {
  assert.equal(createMoondreamVisionProvider({ endpoint: 'cloud', apiKey: '', localUrl: '' }).isConfigured(), false)
  assert.equal(createMoondreamVisionProvider({ endpoint: 'local', apiKey: '', localUrl: '' }).isConfigured(), false)
  // Whitespace-only counts as blank — a stray space must not read as "set".
  assert.equal(createMoondreamVisionProvider({ endpoint: 'cloud', apiKey: '   ', localUrl: '' }).isConfigured(), false)
  assert.equal(createMoondreamVisionProvider({ endpoint: 'local', apiKey: '', localUrl: '   ' }).isConfigured(), false)
})

test('isConfigured() flips true once a key (cloud) or a URL (local) is actually set', () => {
  assert.equal(cloudProvider().isConfigured(), true)
  assert.equal(localProvider().isConfigured(), true)
  // A cloud key has no bearing on the local branch, and vice versa.
  assert.equal(createMoondreamVisionProvider({ endpoint: 'local', apiKey: 'sk-test-key', localUrl: '' }).isConfigured(), false)
  assert.equal(createMoondreamVisionProvider({ endpoint: 'cloud', apiKey: '', localUrl: 'http://localhost:2020/v1/detect' }).isConfigured(), false)
})

test('a well-formed response returns normalised boxes, and calls the right endpoint with the right auth', async () => {
  const { restore, calls } = stubFetch(200, {
    objects: [{ x_min: 0.1, y_min: 0.2, x_max: 0.5, y_max: 0.6 }],
  })
  try {
    const boxes = await cloudProvider().detect('QUJD', 'lantern')
    assert.deepEqual(boxes, [{ xMin: 0.1, yMin: 0.2, xMax: 0.5, yMax: 0.6 }])

    assert.equal(calls.length, 1)
    const call = calls[0]
    assert.ok(call)
    assert.equal(call.url, 'https://api.moondream.ai/v1/detect')
    assert.equal(headerRecord(call.init)['Authorization'], 'Bearer sk-test-key')
    const sent: unknown = JSON.parse(String(call.init.body))
    assert.ok(sent && typeof sent === 'object')
    const body = sent as Record<string, unknown>
    assert.equal(body['object'], 'lantern')
    assert.equal(body['stream'], false)
    // A raw base64 string (no data: prefix) must be wrapped before it is sent —
    // Moondream's /v1/detect only accepts a URL, data: or otherwise.
    assert.equal(body['image_url'], 'data:image/jpeg;base64,QUJD')
  } finally {
    restore()
  }
})

test('an image already carrying a data: URL is passed through unprefixed', async () => {
  const { restore, calls } = stubFetch(200, { objects: [] })
  try {
    await cloudProvider().detect('data:image/png;base64,ZZZ', 'door')
    const call = calls[0]
    assert.ok(call)
    const body = JSON.parse(String(call.init.body)) as Record<string, unknown>
    assert.equal(body['image_url'], 'data:image/png;base64,ZZZ')
  } finally {
    restore()
  }
})

test('the local endpoint sends no Authorization header and hits the configured URL', async () => {
  const { restore, calls } = stubFetch(200, { objects: [] })
  try {
    await localProvider('http://localhost:2020/v1/detect').detect('QUJD', 'crate')
    const call = calls[0]
    assert.ok(call)
    assert.equal(call.url, 'http://localhost:2020/v1/detect')
    assert.equal(headerRecord(call.init)['Authorization'], undefined)
  } finally {
    restore()
  }
})

test('boxes with bad geometry are dropped, not thrown, leaving the well-formed ones intact', async () => {
  const { restore } = stubFetch(200, {
    objects: [
      { x_min: 0.1, y_min: 0.1, x_max: 0.4, y_max: 0.4 }, // good
      { x_min: 0.5, y_min: 0.5, x_max: 0.5, y_max: 0.9 }, // zero-width, degenerate
      { x_min: 'nope', y_min: 0.1, x_max: 0.4, y_max: 0.4 }, // non-numeric
      { y_min: 0.1, x_max: 0.4, y_max: 0.4 }, // missing x_min entirely
      'not even an object',
    ],
  })
  try {
    const boxes = await cloudProvider().detect('QUJD', 'crate')
    assert.deepEqual(boxes, [{ xMin: 0.1, yMin: 0.1, xMax: 0.4, yMax: 0.4 }])
  } finally {
    restore()
  }
})

test('a malformed body (no "objects" list) throws rather than returning junk', async () => {
  const { restore } = stubFetch(200, { not_objects: 'surprise' })
  try {
    await assert.rejects(() => cloudProvider().detect('QUJD', 'crate'), (e: unknown) => {
      if (!isVisionError(e)) return false
      assert.match(e.message, /objects/)
      return true
    })
  } finally {
    restore()
  }
})

test('a non-JSON-object body throws rather than returning junk', async () => {
  const { restore } = stubFetch(200, ['not', 'an', 'object'])
  try {
    await assert.rejects(() => cloudProvider().detect('QUJD', 'crate'), VisionError)
  } finally {
    restore()
  }
})

test('a 401 throws prose naming the key', async () => {
  const { restore } = stubFetch(401, { error: { message: 'invalid API key' } })
  try {
    await assert.rejects(() => cloudProvider().detect('QUJD', 'crate'), (e: unknown) => {
      if (!isVisionError(e)) return false
      assert.equal(e.status, 401)
      assert.match(e.message, /key/i)
      assert.match(e.message, /invalid API key/)
      return true
    })
  } finally {
    restore()
  }
})

test('a 403 also reads as a rejected key', async () => {
  const { restore } = stubFetch(403, { error: 'forbidden' })
  try {
    await assert.rejects(() => cloudProvider().detect('QUJD', 'crate'), (e: unknown) => {
      if (!isVisionError(e)) return false
      assert.equal(e.status, 403)
      assert.match(e.message, /key/i)
      return true
    })
  } finally {
    restore()
  }
})

test('a 429 reads as rate-limited', async () => {
  const { restore } = stubFetch(429, { error: 'slow down' })
  try {
    await assert.rejects(() => cloudProvider().detect('QUJD', 'crate'), (e: unknown) => {
      if (!isVisionError(e)) return false
      assert.equal(e.status, 429)
      assert.match(e.message, /rate.?limit/i)
      return true
    })
  } finally {
    restore()
  }
})

test('detect() without a key (cloud) throws before ever touching the network', async () => {
  const original = globalThis.fetch
  let called = false
  const neverCalled = (async () => {
    called = true
    throw new Error('should never be called')
  }) as unknown as typeof fetch
  globalThis.fetch = neverCalled
  try {
    await assert.rejects(
      () => createMoondreamVisionProvider({ endpoint: 'cloud', apiKey: '', localUrl: '' }).detect('QUJD', 'crate'),
      (e: unknown) => {
        if (!isVisionError(e)) return false
        assert.equal(e.status, 401)
        assert.match(e.message, /key/i)
        return true
      },
    )
    assert.equal(called, false, 'the keyless promise: no key means no request, ever')
  } finally {
    globalThis.fetch = original
  }
})

test('detect() without a URL (local) throws before ever touching the network', async () => {
  const original = globalThis.fetch
  let called = false
  const neverCalled = (async () => {
    called = true
    throw new Error('should never be called')
  }) as unknown as typeof fetch
  globalThis.fetch = neverCalled
  try {
    await assert.rejects(() => createMoondreamVisionProvider({ endpoint: 'local', apiKey: '', localUrl: '' }).detect('QUJD', 'crate'), VisionError)
    assert.equal(called, false, 'the keyless promise: no configured local URL means no request, ever')
  } finally {
    globalThis.fetch = original
  }
})

test('a local URL that refuses connection names the URL and mentions Moondream Station', async () => {
  const original = globalThis.fetch
  const refused = (async () => {
    throw new Error('ECONNREFUSED')
  }) as unknown as typeof fetch
  globalThis.fetch = refused
  try {
    await assert.rejects(
      () => localProvider('http://localhost:2020/v1/detect').detect('QUJD', 'crate'),
      (e: unknown) => {
        if (!isVisionError(e)) return false
        assert.match(e.message, /localhost:2020/)
        assert.match(e.message, /Moondream Station/)
        return true
      },
    )
  } finally {
    globalThis.fetch = original
  }
})

test('the arrows LOOK, and the transport knows what that means', async () => {
  // A chip arms only when its object is in FRONT of the camera, and an off-axis
  // one says "turn to face". The arrows used to strafe, so that instruction
  // asked for a control the player did not have — measured on a live session as
  // 91 seconds of pressing them with the chip never arming. The transport had
  // set_look_horizontal all along.
  const { driveCommandsForTest } = await import('../../src/provider/world/reactor')
  const look = driveCommandsForTest('look_right')
  assert.deepEqual(look, [{ name: 'set_look_horizontal', data: { look_horizontal: 'right' } }])
  assert.deepEqual(driveCommandsForTest('look_left'), [{ name: 'set_look_horizontal', data: { look_horizontal: 'left' } }])
  // …and moving is still moving: the two registers are separate channels —
  // longitudinal and lateral are SEPARATE commands on this transport, which is
  // what the per-axis stop tokens in keys.ts are shaped around.
  assert.deepEqual(driveCommandsForTest('Front'), [{ name: 'set_move_longitudinal', data: { move_longitudinal: 'forward' } }])
  assert.deepEqual(driveCommandsForTest('Left'), [{ name: 'set_move_lateral', data: { move_lateral: 'strafe_left' } }])
})
