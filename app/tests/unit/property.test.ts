/**
 * Property-style tests: instead of pinning individual examples, these assert an
 * invariant across hundreds of generated cases. No dependency is added for
 * this — fast-check and friends are one more package on a shrink-wrapped tree —
 * so the generator is a tiny seeded PRNG (xorshift32) and a handful of "build a
 * random valid X" functions. Deterministic on purpose: a failing case must
 * reproduce on the next run, not roll new dice and pass.
 *
 * Three contracts, each load-bearing enough that an example test would miss a
 * regression in the corner it didn't happen to write down:
 *
 *  1. `url-state`'s round trip (`src/studio/url-state.ts`) — every addressable
 *     view must survive being written to a URL and read back, because the whole
 *     point of the module is that a URL IS the state.
 *  2. `schema`'s coercion (`src/tool/schema.ts`) — coercing an already-coerced
 *     record must be a no-op, or a tool that re-validates its own input (the
 *     app does, on every dispatch) would silently mutate it.
 *  3. `define`'s `recover()` (`src/tool/define.ts`) — the one rule the CLI's
 *     forgiveness depends on is that a typo can never auto-run a write.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'

import { readUrlState, writeUrlState, DEFAULT_URL_STATE, SECTIONS, type UrlState } from '../../src/studio/url-state'
import type { ThemeName } from '../../src/theme'
import { parseArgs, coerce, ToolInputError, type Params, type Param, type ParamType } from '../../src/tool/schema'
import { recover, leaves, resolve, isLeaf } from '../../src/tool/define'
import { root } from '../../src/tool/root'

// ── A tiny seeded PRNG ───────────────────────────────────────────────────────

/** xorshift32. Deterministic: the same seed always produces the same sequence,
 *  so a failing case is a fixed reproduction, not a coin flip. */
function makeRng(seed: number): () => number {
  let state = seed | 0
  if (state === 0) state = 0x9e3779b9
  return () => {
    state ^= state << 13
    state ^= state >>> 17
    state ^= state << 5
    return (state >>> 0) / 4294967296
  }
}

function pick<T>(rng: () => number, items: readonly T[]): T {
  const item = items[Math.floor(rng() * items.length) % items.length]
  if (item === undefined) throw new Error('pick: called with an empty list')
  return item
}

/** Letters, digits, and the URL-hostile characters `&=?#%` plus a spread of
 *  other punctuation — everything an id typed by a human or copy-pasted from
 *  somewhere else might contain. Deliberately excludes `-`: it is only ever
 *  used to build CLI argv values too, where a leading `--` would be misread as
 *  a flag rather than a value. */
const WEIRD_ALPHABET =
  'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789&=?#%+ /.:@!$~'
const ALNUM_ALPHABET = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789'

function randomString(rng: () => number, minLen: number, maxLen: number, alphabet: string): string {
  const len = minLen + Math.floor(rng() * (maxLen - minLen + 1))
  let out = ''
  for (let i = 0; i < len; i += 1) out += pick(rng, alphabet.split(''))
  return out
}

// ── Property 1: url-state round-trips, and is total on garbage ─────────────

const THEMES: readonly ThemeName[] = ['dark', 'light']

/** An id field (`world`/`tab`/`sel`/`play`) is null most of the time, an
 *  ordinary string sometimes, and occasionally the empty string on purpose —
 *  `writeUrlState` treats `''` the same as absent (`if (state.worldId) ...`),
 *  so the empty case is the one place the round trip is NOT the identity, and
 *  it needs to be exercised, not avoided. */
function randomIdField(rng: () => number): string | null {
  if (rng() < 0.3) return null
  if (rng() < 0.15) return ''
  return randomString(rng, 1, 16, WEIRD_ALPHABET)
}

function randomUrlState(rng: () => number): UrlState {
  return {
    section: pick(rng, SECTIONS),
    worldId: randomIdField(rng),
    tab: randomIdField(rng),
    sel: randomIdField(rng),
    playId: randomIdField(rng),
    campaignId: randomIdField(rng),
    playState: randomIdField(rng),
    playVariant: randomIdField(rng),
    settings: rng() < 0.5,
    theme: rng() < 0.3 ? null : pick(rng, THEMES),
  }
}

/** The round trip's own contract, read off `writeUrlState`: an id field of
 *  `''` is indistinguishable from absent once written (falsy check), so it
 *  reads back as `null`. Every other field is exact. */
function normalizeForRoundTrip(state: UrlState): UrlState {
  const collapse = (v: string | null): string | null => (v === '' ? null : v)
  return {
    ...state,
    worldId: collapse(state.worldId),
    tab: collapse(state.tab),
    sel: collapse(state.sel),
    playId: collapse(state.playId),
    campaignId: collapse(state.campaignId),
    playState: collapse(state.playState),
    playVariant: collapse(state.playVariant),
  }
}

test('url-state round-trip: readUrlState(writeUrlState(s)) equals s, normalized per the module contract', () => {
  const rng = makeRng(0xc0ffee)
  for (let i = 0; i < 300; i += 1) {
    const state = randomUrlState(rng)
    const roundTripped = readUrlState(writeUrlState(state))
    assert.deepEqual(
      roundTripped,
      normalizeForRoundTrip(state),
      `case ${i}: ${JSON.stringify(state)} -> ${writeUrlState(state)} -> ${JSON.stringify(roundTripped)}`,
    )
  }
})

/** A garbage character: mostly ordinary punctuation-heavy ASCII (the kind a
 *  hand-edited URL actually contains), sometimes a raw control code, sometimes
 *  a lone `%` sequence (malformed percent-encoding), synthesized by char code
 *  so nothing unprintable has to live in the source file itself. */
function randomGarbageChar(rng: () => number): string {
  const bucket = rng()
  if (bucket < 0.55) return String.fromCharCode(0x20 + Math.floor(rng() * (0x7e - 0x20 + 1)))
  if (bucket < 0.7) return String.fromCharCode(Math.floor(rng() * 0x20))
  if (bucket < 0.9) return String.fromCharCode(0x80 + Math.floor(rng() * (0x2fff - 0x80)))
  return pick(rng, ['%', '%2', '%zz', '%%', '#', '?', '&', '=', '=='])
}

function randomGarbageQuery(rng: () => number, maxLen = 48): string {
  const len = Math.floor(rng() * maxLen)
  let s = ''
  for (let i = 0; i < len; i += 1) s += randomGarbageChar(rng)
  return s
}

test('readUrlState is total: arbitrary garbage query strings never throw and shape-check', () => {
  const rng = makeRng(0xdeadbeef)
  for (let i = 0; i < 300; i += 1) {
    const garbage = randomGarbageQuery(rng)
    let result: UrlState
    try {
      result = readUrlState(garbage)
    } catch (err) {
      assert.fail(`case ${i}: readUrlState threw on ${JSON.stringify(garbage)}: ${String(err)}`)
    }
    assert.ok(SECTIONS.includes(result.section), `case ${i}: bad section ${result.section}`)
    assert.ok(
      result.theme === null || result.theme === 'dark' || result.theme === 'light',
      `case ${i}: bad theme ${String(result.theme)}`,
    )
    assert.equal(typeof result.settings, 'boolean')
    for (const field of ['worldId', 'tab', 'sel', 'playId'] as const) {
      const v = result[field]
      assert.ok(v === null || typeof v === 'string', `case ${i}: ${field} was ${typeof v}`)
    }
  }
})

function randomInvalid(rng: () => number, exclude: readonly string[]): string {
  let candidate = randomString(rng, 1, 10, ALNUM_ALPHABET)
  while (exclude.includes(candidate)) candidate = randomString(rng, 1, 10, ALNUM_ALPHABET)
  return candidate
}

test('an invalid section or theme always falls back to the documented default, never to garbage', () => {
  const rng = makeRng(1234)
  for (let i = 0; i < 200; i += 1) {
    const badSection = randomInvalid(rng, SECTIONS)
    const badTheme = randomInvalid(rng, THEMES)
    const qs = `?section=${encodeURIComponent(badSection)}&theme=${encodeURIComponent(badTheme)}`
    const result = readUrlState(qs)
    assert.equal(result.section, DEFAULT_URL_STATE.section, `case ${i}: section did not fall back for ${qs}`)
    assert.equal(result.theme, null, `case ${i}: theme did not fall back for ${qs}`)
  }
})

// ── Property 2: parameter schema — coercion is idempotent, failures are total ─

const KINDS: readonly ParamType[] = ['string', 'number', 'boolean', 'enum', 'json']

function randomEnumValues(rng: () => number): string[] {
  const n = 2 + Math.floor(rng() * 3)
  const values = new Set<string>()
  while (values.size < n) values.add(randomString(rng, 1, 6, ALNUM_ALPHABET))
  return [...values]
}

function randomSafeString(rng: () => number): string {
  return randomString(rng, 0, 12, WEIRD_ALPHABET)
}

function randomNumberToken(rng: () => number): string {
  const n = (rng() - 0.5) * 2000
  return rng() < 0.5 ? String(Math.round(n)) : n.toFixed(3)
}

/** A JSON payload whose TOP LEVEL is never a bare string. That is the one
 *  shape `coerce` cannot round-trip through a second application: a decoded
 *  string is fed back in as `typeof value === 'string'` and re-parsed as JSON,
 *  which throws (or silently changes type) unless the string happens to be
 *  valid JSON on its own. Numbers, booleans, null, arrays and objects are all
 *  safe — `coerce` only re-parses when the incoming value is already a
 *  string, so anything else passes through untouched on every application. */
function randomJsonPayload(rng: () => number): unknown {
  const shape = rng()
  if (shape < 0.2) return Math.floor((rng() - 0.5) * 2000)
  if (shape < 0.4) return rng() < 0.5
  if (shape < 0.5) return null
  if (shape < 0.75) return [randomString(rng, 0, 5, ALNUM_ALPHABET), Math.floor(rng() * 10), rng() < 0.5]
  return { a: randomString(rng, 0, 5, ALNUM_ALPHABET), n: Math.floor(rng() * 10) }
}

function defaultFor(kind: ParamType, values: readonly string[] | undefined): string | number | boolean {
  switch (kind) {
    case 'string':
      return 'default-str'
    case 'number':
      return 7
    case 'boolean':
      return false
    case 'enum':
      return (values ?? ['x'])[0] ?? 'x'
    case 'json':
      // A raw primitive default, not a JSON-encoded string — `coerce` never
      // re-parses a non-string, so this is always a fixed point (see above).
      return 0
  }
}

/** A CLI-style string token for `--flag <token>`, matching `kind`. */
function tokenValueFor(rng: () => number, kind: ParamType, values: readonly string[] | undefined): string {
  switch (kind) {
    case 'string':
      return randomSafeString(rng)
    case 'number':
      return randomNumberToken(rng)
    case 'enum':
      return pick(rng, values ?? ['x'])
    case 'json':
      return JSON.stringify(randomJsonPayload(rng))
    case 'boolean':
      throw new Error('boolean params use --flag/--no-flag, not a value token')
  }
}

/** An already-typed value `coerce` accepts directly, for tests that call
 *  `coerce` without going through `parseArgs`'s argv string layer. */
function rawValueFor(rng: () => number, kind: ParamType, values: readonly string[] | undefined): unknown {
  switch (kind) {
    case 'string':
      return randomSafeString(rng)
    case 'number':
      return Number(randomNumberToken(rng))
    case 'boolean':
      return rng() < 0.5
    case 'enum':
      return pick(rng, values ?? ['x'])
    case 'json':
      return randomJsonPayload(rng)
  }
}

interface GeneratedCase {
  spec: Params
  argv: string[]
}

/** A random params spec plus one argv that satisfies it — mirroring the real
 *  tree's own shape (`author/tools.ts`, `world/tools.ts`): zero to two
 *  required positional strings (a `world`/`id` chain), then a handful of flags
 *  spanning every type, required/defaulted/optional in any mix. `f0` is always
 *  required so every generated case has at least one required parameter to
 *  drop in the "missing required" property below. */
function buildCase(rng: () => number): GeneratedCase {
  const spec: Params = {}
  const argv: string[] = []

  const posCount = Math.floor(rng() * 3)
  for (let i = 0; i < posCount; i += 1) {
    const name = `pos${i}`
    spec[name] = { type: 'string', describe: 'positional value', required: true, positional: i }
    argv.push(randomSafeString(rng))
  }

  const flagCount = 1 + Math.floor(rng() * 4)
  for (let i = 0; i < flagCount; i += 1) {
    const name = `f${i}`
    const kind = pick(rng, KINDS)
    const values = kind === 'enum' ? randomEnumValues(rng) : undefined
    const param: Param = { type: kind, describe: 'flag value' }
    if (values) param.values = values

    let includeInArgv = true
    if (i === 0 || rng() < 0.34) {
      param.required = true
    } else if (rng() < 0.5) {
      param.default = defaultFor(kind, values)
      includeInArgv = rng() < 0.5
    } else {
      includeInArgv = rng() < 0.5
    }
    spec[name] = param

    if (includeInArgv) {
      if (kind === 'boolean') {
        argv.push(rng() < 0.5 ? `--${name}` : `--no-${name}`)
      } else {
        argv.push(`--${name}`, tokenValueFor(rng, kind, values))
      }
    }
  }

  return { spec, argv }
}

test('parseArgs -> coerce is a fixed point: coercing a coerced record changes nothing', () => {
  const rng = makeRng(0x5eed01)
  for (let i = 0; i < 250; i += 1) {
    const { spec, argv } = buildCase(rng)
    const parsed = parseArgs(spec, argv)
    const reCoerced = coerce(spec, parsed)
    assert.deepEqual(
      reCoerced,
      parsed,
      `case ${i}: spec=${JSON.stringify(spec)} argv=${JSON.stringify(argv)} parsed=${JSON.stringify(parsed)}`,
    )
  }
})

test('an unrecognized flag always throws ToolInputError, via parseArgs and via coerce', () => {
  const rng = makeRng(0x999)
  for (let i = 0; i < 200; i += 1) {
    const { spec, argv } = buildCase(rng)
    assert.throws(
      () => parseArgs(spec, [...argv, '--totally-unknown-flag', 'x']),
      ToolInputError,
      `case ${i}: parseArgs accepted an unknown flag`,
    )
    assert.throws(
      () => coerce(spec, { totallyUnknownFlag: 'x' }),
      ToolInputError,
      `case ${i}: coerce accepted an undeclared key`,
    )
  }
})

test('a missing required parameter always throws ToolInputError', () => {
  const rng = makeRng(0x321)
  let exercised = 0
  for (let i = 0; i < 200; i += 1) {
    const { spec } = buildCase(rng)
    const requiredNames = Object.entries(spec)
      .filter(([, p]) => p.required === true)
      .map(([name]) => name)
    if (requiredNames.length === 0) continue // buildCase always sets f0 required; defensive only
    exercised += 1
    const drop = pick(rng, requiredNames)
    const raw: Record<string, unknown> = {}
    for (const [name, param] of Object.entries(spec)) {
      if (name === drop) continue
      raw[name] = rawValueFor(rng, param.type, param.values)
    }
    assert.throws(() => coerce(spec, raw), ToolInputError, `case ${i}: missing "${drop}" did not throw`)
  }
  assert.ok(exercised > 0, 'no generated case exercised a required parameter')
})

test('an enum value outside its declared values always throws ToolInputError', () => {
  const rng = makeRng(0x777)
  for (let i = 0; i < 200; i += 1) {
    const values = randomEnumValues(rng)
    const spec: Params = { choice: { type: 'enum', describe: 'a choice', values, required: true } }
    const bogus = randomInvalid(rng, values)
    assert.throws(() => coerce(spec, { choice: bogus }), ToolInputError, `case ${i}: coerce accepted "${bogus}"`)
    assert.throws(
      () => parseArgs(spec, ['--choice', bogus]),
      ToolInputError,
      `case ${i}: parseArgs accepted "${bogus}"`,
    )
  }
})

// ── Property 3: recover()'s suggestion behaviour is always safe ────────────

const MUTATION_CHARS = 'abcdefghijklmnopqrstuvwxyz'

/** Replace exactly one character of `path` with a different one, at a random
 *  position — a one-character typo, the case `recover` exists for. */
function mutateOneChar(rng: () => number, path: string): string {
  const chars = path.split('')
  const idx = Math.floor(rng() * chars.length)
  const original = chars[idx]
  if (original === undefined) throw new Error('mutateOneChar: path is empty')
  let replacement = pick(rng, MUTATION_CHARS.split(''))
  while (replacement === original) replacement = pick(rng, MUTATION_CHARS.split(''))
  chars[idx] = replacement
  return chars.join('')
}

test("recover(): a one-character typo of any real leaf path is always safe — resolves, suggests a real leaf, or gives up, and NEVER auto-runs a mutation", () => {
  const rng = makeRng(0xabc123)
  const realLeaves = leaves(root)
  assert.ok(realLeaves.length > 0, 'expected a real tree to walk')

  let matchedOriginal = 0
  let total = 0

  for (const { path: originalPath } of realLeaves) {
    for (let trial = 0; trial < 8; trial += 1) {
      total += 1
      const mutated = mutateOneChar(rng, originalPath)
      const result = recover(root, mutated)

      if ('tool' in result) {
        // A tool came back — either an exact walk of the mutated text (it
        // happens to literally spell another real path), or `recover`'s own
        // typo correction. Either way it must be a real leaf.
        assert.ok(isLeaf(result.tool), `mutated "${mutated}" (from "${originalPath}") resolved to a non-leaf`)
        if (result.corrected) {
          // The hard safety invariant: a typo may only ever be auto-run when
          // the thing it lands on is a read.
          assert.equal(
            result.tool.kind,
            'query',
            `mutated "${mutated}" (from "${originalPath}") auto-ran a ${result.tool.kind} at "${result.path}"`,
          )
          if (result.path === originalPath) matchedOriginal += 1
        } else {
          // An exact match means the mutated text IS that path in the tree.
          assert.equal(resolve(root, mutated), result.tool)
          if (mutated === originalPath) matchedOriginal += 1
        }
      } else {
        // No auto-run. A bare suggestion must point at a real leaf too — never
        // a hallucinated path — and `{}` (no suggestion at all) is always fine.
        assert.ok(
          result.suggestion === undefined || typeof result.suggestion === 'string',
          `mutated "${mutated}" (from "${originalPath}") gave an odd suggestion shape`,
        )
        if (result.suggestion !== undefined) {
          const suggested = resolve(root, result.suggestion)
          assert.ok(
            suggested !== undefined && isLeaf(suggested),
            `mutated "${mutated}" (from "${originalPath}") suggested "${result.suggestion}", which is not a real leaf`,
          )
          if (result.suggestion === originalPath) matchedOriginal += 1
        }
      }
    }
  }

  // The common case is that a one-character typo's closest match IS the path
  // it came from. It is not the ONLY case: two real paths a single edit apart
  // (e.g. `world.export` / `world.import`, edit-distance 2) can tie at
  // distance 1 from a mutation of either, and `recover` breaks ties by tree
  // order — so the suggestion can legitimately land on the OTHER real path.
  // That is exactly why the safety assertion above keys off `tool.kind`, not
  // off "did it suggest the original". This is a majority check, not a 100%
  // one, so it does not fail on that legitimate tie.
  assert.ok(
    matchedOriginal / total > 0.85,
    `only ${matchedOriginal}/${total} one-character typos resolved back to their own path`,
  )
})
