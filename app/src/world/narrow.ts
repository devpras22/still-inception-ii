/**
 * Boundary narrowers for AlakazamClient (api.ts) — the hosted /v1 API is this
 * repo's single biggest untrusted surface, and this module is the seam that
 * turns its raw JSON into something the type system can honestly stand behind.
 *
 * NOT a validation library. It proves CONTAINER-level shape — this is an
 * object, that is an array, this key is a string — for the fields a caller
 * actually relies on. It never recurses into an SMState or a Diagnostic to
 * check ITS fields: api.ts's own domain types already declare those loosely
 * (optional fields, index signatures), and this module leaves them exactly
 * that loose. A mismatch on a checked field throws HttpError so a lying
 * backend reads as a loud failed request — never a downstream
 * `undefined.foo`.
 *
 * Private to api.ts: not part of the world domain's public face. Nothing here
 * is re-exported from ../index.ts — see that file's doc comment.
 */

import type { ApiError } from './api'

/** A real Error that structurally IS an ApiError — everything this repo's
 *  error handling reads (`status`, `detail`, `diagnostics`) is a genuine own
 *  property, never bolted on after the fact with an assertion. The
 *  `implements` clause is the compiler's own proof that this class actually
 *  satisfies the interface, in place of the two unsafe-cast Error builds
 *  this replaces. */
export class HttpError extends Error implements ApiError {
  readonly status: number
  readonly detail: string
  readonly diagnostics?: unknown[] | undefined

  constructor(status: number, detail: string, diagnostics?: unknown[] | undefined) {
    super(detail)
    this.name = 'HttpError'
    this.status = status
    this.detail = detail
    this.diagnostics = diagnostics
  }
}

/** Throw a boundary mismatch, naming the endpoint and what lied about it. */
export function fail(endpoint: string, problem: string): never {
  throw new HttpError(502, `${endpoint}: ${problem}`)
}

export function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

/** Same check, typed for a container whose ENTRIES are trusted at type `V`
 *  without inspection — exactly as loose as the domain interfaces themselves
 *  already declare their deep interiors. */
export function isRecordOf<V = unknown>(v: unknown): v is Record<string, V> {
  return isRecord(v)
}

/** Array counterpart of `isRecordOf`: proves array-ness, trusts the element type. */
export function isArrayOf<V = unknown>(v: unknown): v is V[] {
  return Array.isArray(v)
}

/** The "did this even come back as an object" check every parse opens with. */
export function expectRecord(v: unknown, endpoint: string): Record<string, unknown> {
  if (!isRecord(v)) fail(endpoint, 'response is not an object')
  return v
}

// ── Required (throws on missing/wrong type) ──────────────────────────────────

export function reqString(o: Record<string, unknown>, key: string, endpoint: string): string {
  const v = o[key]
  if (typeof v !== 'string') fail(endpoint, `response missing string ${key}`)
  return v
}

export function reqStringOrNull(o: Record<string, unknown>, key: string, endpoint: string): string | null {
  const v = o[key]
  if (typeof v === 'string' || v === null) return v
  fail(endpoint, `response missing string-or-null ${key}`)
}

export function reqNumber(o: Record<string, unknown>, key: string, endpoint: string): number {
  const v = o[key]
  if (typeof v !== 'number') fail(endpoint, `response missing number ${key}`)
  return v
}

export function reqBoolean(o: Record<string, unknown>, key: string, endpoint: string): boolean {
  const v = o[key]
  if (typeof v !== 'boolean') fail(endpoint, `response missing boolean ${key}`)
  return v
}

/** Container-only: proves `o[key]` is an array, trusts its elements as `V`. */
export function reqArray<V = unknown>(o: Record<string, unknown>, key: string, endpoint: string): V[] {
  const v = o[key]
  if (!isArrayOf<V>(v)) fail(endpoint, `response missing array ${key}`)
  return v
}

/** Container-only: proves `o[key]` is a plain object, trusts its values as `V`. */
export function reqRecordField<V = unknown>(o: Record<string, unknown>, key: string, endpoint: string): Record<string, V> {
  const v = o[key]
  if (!isRecordOf<V>(v)) fail(endpoint, `response missing object ${key}`)
  return v
}

// ── Optional / lenient (never throws — absent or wrong-typed becomes the
//    fallback, matching how this codebase already treats advisory fields:
//    e.g. `res.diagnostics ?? []` at the call sites) ─────────────────────────

export function optString(o: Record<string, unknown>, key: string): string | undefined {
  const v = o[key]
  return typeof v === 'string' ? v : undefined
}

export function optStringOrNull(o: Record<string, unknown>, key: string): string | null | undefined {
  const v = o[key]
  return typeof v === 'string' || v === null ? v : undefined
}

export function optNumber(o: Record<string, unknown>, key: string): number | undefined {
  const v = o[key]
  return typeof v === 'number' ? v : undefined
}

export function optBoolean(o: Record<string, unknown>, key: string): boolean | undefined {
  const v = o[key]
  return typeof v === 'boolean' ? v : undefined
}

/** Lenient array: defaults to `[]` rather than throwing — for fields callers
 *  already read with a `?? []` fallback, so a missing one is not new news. */
export function defaultArray<V = unknown>(o: Record<string, unknown>, key: string): V[] {
  const v = o[key]
  return isArrayOf<V>(v) ? v : []
}
