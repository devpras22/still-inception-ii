/**
 * How a failure from the store becomes something a caller can render.
 *
 * The world domain owns the store, so it owns the shapes a store call throws and
 * the diagnostics it returns — and therefore the narrowers for both. The local
 * store throws `StoreError` and the hosted client throws an `ApiError`-shaped
 * Error; they are two classes with one structural shape, so nothing here uses
 * `instanceof` across the boundary. Everything is a `typeof`/`in` guard, so this
 * file carries no unsafe assertion.
 *
 * These absorb three copies that had drifted apart: two verbatim `normalizeDiag`
 * functions (Agent, Lint) and the eight hand-rolled `ApiError → string` blocks.
 */

import type { Diagnostic } from './api'

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null
}

function str(v: unknown): string {
  return typeof v === 'string' ? v : ''
}

/** Normalize one unknown value into a Diagnostic. Total: anything becomes one. */
function toDiagnostic(d: unknown): Diagnostic {
  const o = isRecord(d) ? d : {}
  const sev = o['severity']
  const severity: Diagnostic['severity'] = sev === 'warning' || sev === 'info' ? sev : 'error'
  return {
    lint: str(o['lint']),
    severity,
    path: str(o['path']),
    message: typeof o['message'] === 'string' ? o['message'] : typeof d === 'string' ? d : JSON.stringify(d),
  }
}

/** Normalize an unknown list (a thrown error's `.diagnostics`, a result's) into Diagnostics. */
export function toDiagnostics(raw: unknown): Diagnostic[] {
  return Array.isArray(raw) ? raw.map(toDiagnostic) : []
}

export interface ApiFailure {
  /** HTTP-ish status; 0 when the call never reached a response. */
  status: number
  detail: string
  diagnostics: Diagnostic[]
}

/**
 * Narrow anything thrown by a store call into a renderable failure. Reads the
 * structural `{ status, detail, diagnostics }` shape that StoreError and the
 * hosted ApiError both satisfy; falls back to an Error message, then to a string.
 */
export function toApiFailure(e: unknown): ApiFailure {
  if (isRecord(e)) {
    const status = typeof e['status'] === 'number' ? e['status'] : 0
    const detail =
      str(e['detail']) || str(e['message']) || (status ? `request failed (${status})` : 'request failed')
    return { status, detail, diagnostics: toDiagnostics(e['diagnostics']) }
  }
  return { status: 0, detail: typeof e === 'string' ? e : 'request failed', diagnostics: [] }
}
