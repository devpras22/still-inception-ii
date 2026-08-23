/**
 * runTool — the tool tree, invoked in process.
 *
 * `dispatch` walks the tree from argv, for the terminal. `runTool` walks the
 * same tree from structured input, for the app. Both end at the SAME gate
 * (`coerce`) and the SAME execution, which is what stops the app's validation
 * from drifting from the CLI's — there is one place a leaf's parameters are
 * checked, and both consumers go through it.
 *
 * It NEVER throws and it NEVER auto-corrects. A programmatic caller is code, and
 * a typo in code must fail loudly even for a read — `dispatch`'s
 * forgiving-on-reads recovery is a courtesy for someone typing at a prompt, not
 * a behaviour to smuggle into the app. Everything folds into one envelope.
 *
 * Structural reads are inline and generic on purpose: the primitive stays free
 * of any domain's runtime (so the CLI never loads React through it). The
 * world-facing normalizers that render these failures live in the world domain.
 */

import { isLeaf, resolve, recover, type Tool, type ToolContext } from './define'
import { coerce, ToolInputError } from './schema'
import type { Diagnostic } from '../world'

/** What a tool call produced. A discriminated union so a caller cannot read a
 *  value off a failure or an error off a success. */
export type ToolOutcome =
  | {
      ok: true
      path: string
      kind: 'query' | 'mutation'
      ms: number
      value: unknown
      /** Lifted from a write result, when present. Undefined for reads. */
      rev: string | undefined
      /** Lifted from a write result; empty when the call carried none. */
      diagnostics: Diagnostic[]
    }
  | {
      ok: false
      path: string
      kind: 'query' | 'mutation' | 'unknown'
      ms: number
      error: ToolFailure
    }

export interface ToolFailure {
  status: number
  message: string
  diagnostics: Diagnostic[]
  /** Precomputed: a stale-revision conflict the caller should reload-and-retry. */
  conflict: boolean
  /** The raw thrown value, for logging — never rendered directly. */
  cause: unknown
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null
}

function readDiagnostics(v: unknown): Diagnostic[] {
  if (!Array.isArray(v)) return []
  // Diagnostics from a store call are already Diagnostic-shaped; anything that is
  // not is dropped rather than trusted. The world normalizers do the richer job
  // for UI; here we only need to carry a well-formed list.
  return v.filter(
    (d): d is Diagnostic =>
      isRecord(d) && typeof d['message'] === 'string' && typeof d['severity'] === 'string',
  )
}

/** Turn any thrown value into a renderable failure, structurally. */
function toFailure(e: unknown): ToolFailure {
  if (e instanceof ToolInputError) {
    return { status: 400, message: e.message, diagnostics: [], conflict: false, cause: e }
  }
  if (isRecord(e)) {
    const status = typeof e['status'] === 'number' ? e['status'] : 0
    const message =
      (typeof e['detail'] === 'string' && e['detail']) ||
      (typeof e['message'] === 'string' && e['message']) ||
      (status ? `request failed (${status})` : 'request failed')
    return { status, message, diagnostics: readDiagnostics(e['diagnostics']), conflict: status === 409, cause: e }
  }
  return { status: 0, message: typeof e === 'string' ? e : 'request failed', diagnostics: [], conflict: false, cause: e }
}

/**
 * Resolve a dotted path, validate the input against the leaf's parameters, and
 * run it. `now` is injected so a caller can supply a monotonic clock; it defaults
 * to a zero timer where none exists (the envelope's `ms` is best-effort, never
 * load-bearing).
 */
export async function runTool(
  tree: Tool,
  path: string,
  input: Record<string, unknown>,
  ctx: ToolContext,
  now: () => number = () => 0,
): Promise<ToolOutcome> {
  const started = now()
  const node = resolve(tree, path)

  if (!node || !isLeaf(node)) {
    const guess = recover(tree, path)
    const suggestion = 'suggestion' in guess ? guess.suggestion : undefined
    return {
      ok: false,
      path,
      kind: 'unknown',
      ms: now() - started,
      error: {
        status: 404,
        message: suggestion ? `unknown tool "${path}" — did you mean "${suggestion}"?` : `unknown tool "${path}"`,
        diagnostics: [],
        conflict: false,
        cause: undefined,
      },
    }
  }

  try {
    const coerced = coerce(node.params, input)
    // The one params/run meeting point — coerce has just validated against
    // exactly these params, mirroring dispatch's single `as never` site.
    const value = await node.run(coerced as never, ctx)
    const rev = isRecord(value) && typeof value['rev'] === 'string' ? value['rev'] : undefined
    const diagnostics = isRecord(value) ? readDiagnostics(value['diagnostics']) : []
    return { ok: true, path, kind: node.kind, ms: now() - started, value, rev, diagnostics }
  } catch (e) {
    return { ok: false, path, kind: node.kind, ms: now() - started, error: toFailure(e) }
  }
}
