import { useCallback, useEffect, useState } from 'react'
import { useClient } from '../studio'
import { toApiFailure } from '../world'
import type { ApiFailure } from '../world'
import { Button, Pill, Spinner } from '../theme'

/** Account = app-level daily usage from GET /v1/usage. Single-tenant: the API key
 *  IS the creator, so there's no per-user billing — just today's usage vs. caps. */
type Usage = { day: string; usage: Record<string, number>; caps: Record<string, number> }

// Known kinds in display order, with friendly labels. We only render kinds that
// are actually present in `caps`; unknown extra kinds are appended (prettified).
const KIND_ORDER: [string, string][] = [
  ['generation', 'Generation'],
  ['session', 'Sessions'],
  ['session_seconds', 'Session seconds'],
  ['edit', 'Agent edits'],
  ['say', 'Say'],
  ['tts', 'TTS'],
  ['image', 'Image'],
  ['seed_frame', 'Seed frame'],
  ['probe', 'Probe'],
  ['perceive', 'Perceive'],
  ['ground', 'Ground'],
]

function labelFor(kind: string): string {
  const known = KIND_ORDER.find(([k]) => k === kind)
  if (known) return known[1]
  return kind.replace(/_/g, ' ').replace(/^\w/, (c) => c.toUpperCase())
}

/** Ordered list of cap kinds: known kinds first (in KIND_ORDER), then any extras. */
function orderedKinds(caps: Record<string, number>): string[] {
  const present = new Set(Object.keys(caps))
  const known = KIND_ORDER.map(([k]) => k).filter((k) => present.has(k))
  const extras = Object.keys(caps).filter((k) => !KIND_ORDER.some(([kk]) => kk === k))
  return [...known, ...extras]
}

function maskKey(k: string): string {
  if (!k) return '(none)'
  const m = k.match(/^((?:pk|sk)_(?:test|live)_)(.*)$/)
  if (m) {
    const tail = m[2] ?? ''
    const last4 = tail.length > 4 ? tail.slice(-4) : ''
    return `${m[1]}${'•'.repeat(6)}${last4}`
  }
  return k.length > 8 ? `${k.slice(0, 4)}…${k.slice(-4)}` : '••••'
}

function UsageBar({ used, cap }: { used: number; cap: number }) {
  const over = cap > 0 && used > cap
  const pct = cap > 0 ? Math.min(100, (used / cap) * 100) : 0
  return (
    <div style={{ height: 8, background: 'var(--input-bg)', border: '1px solid var(--line)', borderRadius: 6, overflow: 'hidden' }}>
      <div style={{ height: '100%', width: `${pct}%`, background: over ? 'var(--err)' : 'var(--acc)', transition: 'width .2s' }} />
    </div>
  )
}

export function Account() {
  const { client, config } = useClient()
  const [data, setData] = useState<Usage | null>(null)
  const [loading, setLoading] = useState(false)
  const [err, setErr] = useState<ApiFailure | null>(null)

  // Usage is a HOSTED endpoint. With no key this fired anyway — on the first
  // click of a top-level nav item, on a clone that had configured nothing — and
  // rendered "invalid or revoked API key" over its own line reading
  // "API key (none)". Two requests to a vendor the user never chose, and the
  // blame pointed at a key they had not entered. The README promises nothing is
  // called until you configure something in Settings; this was the exception.
  const hasKey = !!config.apiKey

  const load = useCallback(async () => {
    if (!hasKey) return
    setLoading(true)
    setErr(null)
    try {
      setData(await client.usage())
    } catch (e) {
      setErr(toApiFailure(e))
    } finally {
      setLoading(false)
    }
  }, [client, hasKey])

  useEffect(() => {
    void load()
  }, [load])

  const kinds = data ? orderedKinds(data.caps) : []

  return (
    <div style={{ maxWidth: 640 }}>
      <div className="row" style={{ justifyContent: 'space-between', marginBottom: 12 }}>
        <h2 style={{ margin: 0 }}>Account</h2>
        <Button variant="ghost" onClick={() => void load()} disabled={loading || !hasKey}>
          {loading ? <Spinner /> : 'Refresh'}
        </Button>
      </div>

      {/* Connected app */}
      <div className="card" style={{ marginBottom: 14 }}>
        <div className="muted" style={{ fontSize: 12, marginBottom: 6 }}>Connected app</div>
        <div className="row" style={{ justifyContent: 'space-between', gap: 12 }}>
          <span className="muted">API base</span>
          <code>{config.apiBase}</code>
        </div>
        <div className="row" style={{ justifyContent: 'space-between', gap: 12, marginTop: 6 }}>
          <span className="muted">API key</span>
          <code>{maskKey(config.apiKey)}</code>
        </div>
      </div>

      {/* Usage */}
      <div className="card">
        {!hasKey && (
          <div className="diag info">
            Usage and billing live on the hosted API. Nothing is fetched until you add a key
            in Settings — the studio itself runs without one, and your worlds are in this
            browser.
          </div>
        )}

        {err && (
          <div className="diag error">
            <strong>Couldn't load usage</strong> {err.status ? `(${err.status})` : ''} — {err.detail}
            {err.diagnostics.length > 0 && (
              <ul style={{ margin: '6px 0 0', paddingLeft: 18 }}>
                {err.diagnostics.map((d, i) => (
                  <li key={i}>{d.message}</li>
                ))}
              </ul>
            )}
          </div>
        )}

        {!err && loading && !data && (
          <div className="muted" style={{ padding: '8px 0' }}>
            <Spinner /> Loading usage…
          </div>
        )}

        {!err && data && (
          <>
            <div className="row" style={{ justifyContent: 'space-between', marginBottom: 12 }}>
              <span className="muted">Daily usage</span>
              <Pill>{data.day}</Pill>
            </div>

            {kinds.length === 0 ? (
              <div className="muted">No caps reported for this key.</div>
            ) : (
              kinds.map((kind) => {
                const cap = data.caps[kind] ?? 0
                const used = data.usage[kind] ?? 0
                return (
                  <div key={kind} style={{ marginBottom: 12 }}>
                    <div className="row" style={{ justifyContent: 'space-between', marginBottom: 4 }}>
                      <span>{labelFor(kind)}</span>
                      <span className="muted">
                        <code>{used}</code> / <code>{cap > 0 ? cap : '∞'}</code>
                      </span>
                    </div>
                    <UsageBar used={used} cap={cap} />
                  </div>
                )
              })
            )}

            <p className="muted" style={{ fontSize: 12, marginTop: 14, marginBottom: 0 }}>
              Billing is currently free — these are daily caps that reset each day (UTC). They
              limit how much of each <code>/v1</code> capability this key can use per day.
            </p>
          </>
        )}
      </div>
    </div>
  )
}
