import { useState } from 'react'
import { useClient } from '../studio'
import type { EditorPanelProps } from './types'
import type { Diagnostic } from '../world'
import { toApiFailure } from '../world'
import { Button, Pill, Spinner } from '../theme'

/**
 * Validate + Lint — the two doctrine checks on a world's graph.
 *
 *  - Validate (`POST /v1/worlds/:id/validate`) is the FAIL-CLOSED gate. 200 → the
 *    world passes structural validation (playable/publishable); 422 → invalid, the
 *    request throws an ApiError whose `diagnostics` explain what blocks it.
 *  - Lint (`POST /v1/worlds/:id/lint`) is ADVISORY doctrine — never blocks. It
 *    returns `{ diagnostics, promptBudget }`: style/quality nudges plus how much of
 *    the per-state prompt budget the world consumes.
 *
 * Both are read-only (no graph write), so there's no `rev`/If-Match to thread. We
 * still handle a 409 defensively per the concurrency rule: reload() + retry toast.
 */

function DiagList({ diags }: { diags: Diagnostic[] }) {
  if (diags.length === 0) return null
  return (
    <div style={{ marginTop: 10 }}>
      {diags.map((d, i) => (
        <div key={`${d.lint}:${d.path}:${i}`} className={`diag ${d.severity}`}>
          {d.message}
          {d.path && (
            <>
              {' '}
              <code>{d.path}</code>
            </>
          )}
          {d.lint && <span className="muted"> [{d.lint}]</span>}
        </div>
      ))}
    </div>
  )
}

type ValidateOutcome =
  | { status: 'ok'; diags: Diagnostic[] }
  | { status: 'invalid'; diags: Diagnostic[] }
  | { status: 'error'; message: string }

type LintOutcome =
  | { status: 'done'; diags: Diagnostic[]; promptBudget: number }
  | { status: 'error'; message: string }

export function LintPanel({ worldId, reload, toast }: EditorPanelProps) {
  const { store } = useClient()
  const [validating, setValidating] = useState(false)
  const [linting, setLinting] = useState(false)
  const [validateOut, setValidateOut] = useState<ValidateOutcome | null>(null)
  const [lintOut, setLintOut] = useState<LintOutcome | null>(null)

  const busy = validating || linting

  async function runValidate() {
    if (busy) return
    setValidating(true)
    setValidateOut(null)
    try {
      const res = await store.validate(worldId)
      // A check that did not run is NOT a pass. Saying "valid" here because the
      // kernel is unavailable offline would be the worst possible lie this panel
      // could tell — it is the one screen an author trusts to catch mistakes.
      if (!res.available) {
        setValidateOut({ status: 'error', message: res.reason })
        toast('validate unavailable', true)
        return
      }
      // `available` only says the check RAN. `ok` says whether it passed, and
      // the hosted store reports a fail-closed rejection as {available:true,
      // ok:false} rather than throwing — so branching on `available` alone told
      // the author "valid — gate passed" about a world the gate had just
      // rejected. That is the precise lie this panel exists to not tell.
      if (!res.ok) {
        setValidateOut({ status: 'invalid', diags: res.diagnostics ?? [] })
        toast('invalid — blocked', true)
        return
      }
      setValidateOut({ status: 'ok', diags: res.diagnostics ?? [] })
      toast('valid — gate passed')
    } catch (e) {
      const f = toApiFailure(e)
      if (f.status === 409) {
        await reload()
        toast('reload & retry', true)
      } else if (f.status === 422) {
        // Fail-closed gate: the world is invalid; diagnostics say why.
        setValidateOut({ status: 'invalid', diags: f.diagnostics })
        toast('invalid — blocked', true)
      } else {
        setValidateOut({ status: 'error', message: f.detail || 'Validate failed.' })
        toast(f.detail || 'validate failed', true)
      }
    } finally {
      setValidating(false)
    }
  }

  async function runLint() {
    if (busy) return
    setLinting(true)
    setLintOut(null)
    try {
      const res = await store.lint(worldId)
      if (!res.available) {
        setLintOut({ status: 'error', message: res.reason })
        toast('lint unavailable', true)
        return
      }
      setLintOut({ status: 'done', diags: res.diagnostics ?? [], promptBudget: res.promptBudget })
    } catch (e) {
      const f = toApiFailure(e)
      if (f.status === 409) {
        await reload()
        toast('reload & retry', true)
      } else {
        setLintOut({ status: 'error', message: f.detail || 'Lint failed.' })
        toast(f.detail || 'lint failed', true)
      }
    } finally {
      setLinting(false)
    }
  }

  return (
    <div>
      <h3>Validate & Lint</h3>

      <div className="diag info" style={{ marginTop: 0 }}>
        <strong>Validate</strong> is the fail-closed gate — a world must pass to publish or play.{' '}
        <strong>Lint</strong> is advisory doctrine — quality nudges that never block.
      </div>

      <div className="row" style={{ marginTop: 12, gap: 8 }}>
        <Button variant="primary" onClick={() => void runValidate()} disabled={busy}>
          {validating ? (
            <>
              <Spinner /> Validating…
            </>
          ) : (
            'Validate'
          )}
        </Button>
        <Button variant="ghost" onClick={() => void runLint()} disabled={busy}>
          {linting ? (
            <>
              <Spinner /> Linting…
            </>
          ) : (
            'Lint'
          )}
        </Button>
      </div>

      {/* ── Validate result ─────────────────────────────────────────── */}
      {validateOut && (
        <div style={{ marginTop: 16 }}>
          <div className="row" style={{ justifyContent: 'space-between' }}>
            <div className="muted" style={{ fontSize: 11 }}>validate — fail-closed gate</div>
            {validateOut.status !== 'error' && (
              <span className={`badge ${validateOut.status === 'ok' ? 'public' : ''}`}>
                {validateOut.status === 'ok' ? 'valid' : 'invalid'}
              </span>
            )}
          </div>
          {validateOut.status === 'error' ? (
            <div className="diag error" style={{ marginTop: 10 }}>{validateOut.message}</div>
          ) : validateOut.diags.length > 0 ? (
            <DiagList diags={validateOut.diags} />
          ) : (
            <div className="diag info" style={{ marginTop: 10 }}>
              {validateOut.status === 'ok'
                ? 'No blocking issues — this world passes the gate.'
                : 'Invalid, but no diagnostics were returned.'}
            </div>
          )}
        </div>
      )}

      {/* ── Lint result ─────────────────────────────────────────────── */}
      {lintOut && (
        <div style={{ marginTop: 16 }}>
          <div className="row" style={{ justifyContent: 'space-between' }}>
            <div className="muted" style={{ fontSize: 11 }}>lint — advisory doctrine</div>
            {lintOut.status === 'done' && (
              <Pill>prompt budget: {lintOut.promptBudget}</Pill>
            )}
          </div>
          {lintOut.status === 'error' ? (
            <div className="diag error" style={{ marginTop: 10 }}>{lintOut.message}</div>
          ) : lintOut.diags.length > 0 ? (
            <DiagList diags={lintOut.diags} />
          ) : (
            <div className="diag info" style={{ marginTop: 10 }}>No advisories — clean by doctrine.</div>
          )}
        </div>
      )}
    </div>
  )
}
