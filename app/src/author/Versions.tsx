import { useCallback, useEffect, useState } from 'react'
import { useClient } from '../studio'
import type { EditorPanelProps } from './types'
import type { VersionNode } from '../world'
import { toApiFailure } from '../world'
import { Button, Checkbox, DangerButton, Field, Pill, Spinner, TextInput } from '../theme'

/**
 * Version history for a world — the deterministic side of iteration.
 *
 *  - Snapshot the current graph (`world.version.snapshot`) → a named point in the tree.
 *  - List the version tree (`listVersions`), parent→child, oldest first — a read, so
 *    it stays direct on the store.
 *  - Pick up to 2 → structural Diff (`diffVersions`): states/events added/removed/changed
 *    — also a direct read.
 *  - Per-version: Rename (`world.version.rename`), Prune (`world.version.delete` — 409 =
 *    can't prune HEAD), Checkout (`world.version.restore`, with `rev` for optimistic
 *    concurrency → GraphEditor.reload()).
 *
 * The mutations above all go through the tool tree (`tools.run`) — the same leaves
 * the CLI runs. Checkout threads the optimistic-concurrency `rev`: on a 409 we
 * reload the scene and ask the user to retry. Snapshot/rename/prune are
 * version-store ops that don't move HEAD, so they only refresh this list.
 */

interface DiffGroup {
  added: string[]
  removed: string[]
  changed: string[]
}
interface DiffResult {
  a: string
  b: string
  states: DiffGroup
  events: DiffGroup
}

const short = (id: string): string => (id.length > 8 ? id.slice(0, 8) : id)

function fmt(ts?: string): string {
  if (!ts) return ''
  const d = new Date(ts)
  return Number.isNaN(d.getTime()) ? ts : d.toLocaleString()
}

/**
 * Flatten the version DAG into a parent-first, depth-tagged list for indentation.
 * Nodes whose parent isn't present are treated as roots; a `seen` guard makes a
 * malformed cycle terminate instead of recursing forever.
 */
function buildOrder(versions: VersionNode[]): { node: VersionNode; depth: number }[] {
  const ids = new Set(versions.map((v) => v.id))
  const children = new Map<string | null, VersionNode[]>()
  for (const v of versions) {
    const key = v.parentVersionId && ids.has(v.parentVersionId) ? v.parentVersionId : null
    const arr = children.get(key) ?? []
    arr.push(v)
    children.set(key, arr)
  }
  for (const arr of children.values()) {
    arr.sort((a, b) => (a.created_at ?? '').localeCompare(b.created_at ?? ''))
  }
  const out: { node: VersionNode; depth: number }[] = []
  const seen = new Set<string>()
  const visit = (parentKey: string | null, depth: number) => {
    for (const v of children.get(parentKey) ?? []) {
      if (seen.has(v.id)) continue
      seen.add(v.id)
      out.push({ node: v, depth })
      visit(v.id, depth + 1)
    }
  }
  visit(null, 0)
  return out
}

function DiffSection({ label, group }: { label: string; group: DiffGroup }) {
  const rows: [string, string, string[]][] = [
    ['added', 'info', group.added],
    ['removed', 'error', group.removed],
    ['changed', 'warning', group.changed],
  ]
  const total = group.added.length + group.removed.length + group.changed.length
  return (
    <div style={{ marginTop: 10 }}>
      <div className="row" style={{ justifyContent: 'space-between', marginBottom: 4 }}>
        <strong style={{ fontSize: 12 }}>{label}</strong>
        <Pill>{total}</Pill>
      </div>
      {total === 0 ? (
        <div className="muted" style={{ fontSize: 12 }}>no changes</div>
      ) : (
        rows.map(([kind, sev, ids]) =>
          ids.length === 0 ? null : (
            <div key={kind} className={`diag ${sev}`}>
              <span className="muted" style={{ textTransform: 'uppercase', fontSize: 10, letterSpacing: '.06em' }}>
                {kind}
              </span>{' '}
              <Pill>{ids.length}</Pill>
              <div style={{ marginTop: 4, display: 'flex', flexWrap: 'wrap', gap: 4 }}>
                {ids.map((id) => (
                  <code key={id} title={id}>
                    {id}
                  </code>
                ))}
              </div>
            </div>
          ),
        )
      )}
    </div>
  )
}

export function VersionsPanel({ worldId, rev, reload, toast }: EditorPanelProps) {
  const { store, tools } = useClient()
  const [versions, setVersions] = useState<VersionNode[] | null>(null)
  const [loading, setLoading] = useState(true)
  const [loadErr, setLoadErr] = useState<string | null>(null)

  const [snapTitle, setSnapTitle] = useState('')
  const [snapBusy, setSnapBusy] = useState(false)

  // Ordered [A, B] selection for diffing (max 2; adding a 3rd drops the oldest).
  const [selected, setSelected] = useState<string[]>([])
  const [diff, setDiff] = useState<DiffResult | null>(null)
  const [diffBusy, setDiffBusy] = useState(false)

  const [actionBusy, setActionBusy] = useState<string | null>(null)
  const [renamingId, setRenamingId] = useState<string | null>(null)
  const [renameText, setRenameText] = useState('')

  const load = useCallback(async () => {
    setLoading(true)
    setLoadErr(null)
    try {
      const res = await store.listVersions(worldId)
      setVersions(res.versions)
    } catch (e) {
      setLoadErr(toApiFailure(e).detail)
      setVersions(null)
    } finally {
      setLoading(false)
    }
  }, [store, worldId])

  useEffect(() => {
    // New world → drop any stale diff/selection, then load its tree.
    setSelected([])
    setDiff(null)
    setRenamingId(null)
    void load()
  }, [load])

  async function doSnapshot() {
    if (snapBusy) return
    setSnapBusy(true)
    try {
      const title = snapTitle.trim()
      const outcome = await tools.run('world.version.snapshot', { world: worldId, ...(title ? { title } : {}) })
      if (outcome.ok) {
        setSnapTitle('')
        await load()
        toast('snapshot saved')
      } else {
        toast(outcome.error.message, true)
      }
    } finally {
      setSnapBusy(false)
    }
  }

  function toggleSelect(id: string) {
    setDiff(null) // any selection change invalidates a shown diff
    setSelected((prev) => {
      if (prev.includes(id)) return prev.filter((x) => x !== id)
      if (prev.length >= 2) return [prev[1] ?? id, id] // keep newest two (drop oldest)
      return [...prev, id]
    })
  }

  async function runDiff() {
    if (selected.length !== 2 || diffBusy) return
    setDiffBusy(true)
    try {
      const [a, b] = selected
      if (a === undefined || b === undefined) return
      const res = await store.diffVersions(worldId, a, b)
      setDiff(res)
    } catch (e) {
      toast(toApiFailure(e).detail, true)
    } finally {
      setDiffBusy(false)
    }
  }

  function beginRename(v: VersionNode) {
    setRenamingId(v.id)
    setRenameText(v.title ?? '')
  }

  async function saveRename(v: VersionNode) {
    if (actionBusy) return
    setActionBusy(v.id)
    try {
      const outcome = await tools.run('world.version.rename', { world: worldId, version: v.id, title: renameText.trim() })
      if (outcome.ok) {
        setRenamingId(null)
        await load()
        toast('renamed')
      } else {
        toast(outcome.error.message, true)
      }
    } finally {
      setActionBusy(null)
    }
  }

  /**
   * Checkout REPLACES the working graph. Everything authored since the
   * snapshot being restored is destroyed — the DangerButton rendering this
   * (below) confirms with exactly what's at stake, the same way "Prune"
   * (which only deletes a copy) has always confirmed.
   *
   * The safety net — a snapshot of the CURRENT graph before overwriting it —
   * lives IN `world.version.restore` itself, on by default, so the answer to
   * "I did not mean that" is a second checkout rather than an apology, and
   * the CLI gets the same guarantee through the same leaf.
   */
  async function doCheckout(v: VersionNode) {
    if (actionBusy) return
    setActionBusy(v.id)
    try {
      const outcome = await tools.run('world.version.restore', { world: worldId, version: v.id, rev })
      if (outcome.ok) {
        await reload() // GraphEditor re-fetches world+scene and refreshes rev
        await load() // a checkout may append a node to the tree
        toast(`checked out ${short(v.id)}`)
      } else if (outcome.error.conflict) {
        await reload()
        toast('reload & retry', true)
      } else {
        toast(outcome.error.message, true)
      }
    } finally {
      setActionBusy(null)
    }
  }

  async function doDelete(v: VersionNode) {
    if (actionBusy) return
    setActionBusy(v.id)
    try {
      const outcome = await tools.run('world.version.delete', { world: worldId, version: v.id })
      if (outcome.ok) {
        setSelected((prev) => prev.filter((x) => x !== v.id))
        setDiff(null)
        await load()
        toast(`pruned ${short(v.id)}`)
      } else {
        // 409 = the version store refuses to prune the current HEAD; the detail
        // arrives in message either way.
        toast(outcome.error.message || "can't prune HEAD", true)
      }
    } finally {
      setActionBusy(null)
    }
  }

  const ordered = versions ? buildOrder(versions) : []

  return (
    <div>
      <div className="row" style={{ justifyContent: 'space-between' }}>
        <h3 style={{ margin: 0 }}>Versions</h3>
        <Button variant="ghost" onClick={() => void load()} disabled={loading}>
          {loading ? <Spinner /> : 'Refresh'}
        </Button>
      </div>
      <p className="muted" style={{ fontSize: 12, marginTop: 4 }}>
        Snapshot the graph, diff any two points, or check one out to restore it.
      </p>

      {/* Snapshot */}
      <Field id="ver-snap-title" label="New snapshot">
        <TextInput
          id="ver-snap-title"
          value={snapTitle}
          onChange={(e) => setSnapTitle(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault()
              void doSnapshot()
            }
          }}
          placeholder="Title (optional)"
          disabled={snapBusy}
        />
      </Field>
      <div style={{ marginTop: 8 }}>
        <Button variant="primary" onClick={() => void doSnapshot()} disabled={snapBusy}>
          {snapBusy ? (
            <>
              <Spinner /> Snapshotting…
            </>
          ) : (
            'Snapshot current'
          )}
        </Button>
      </div>

      {/* Compare bar */}
      {selected.length > 0 && (
        <div className="card" style={{ marginTop: 14, padding: 10, background: 'var(--bg)' }}>
          <div className="row" style={{ justifyContent: 'space-between' }}>
            <span className="muted" style={{ fontSize: 12 }}>
              {selected.length === 2 ? (
                <>
                  <code>{short(selected[0] ?? '')}</code> → <code>{short(selected[1] ?? '')}</code>
                </>
              ) : (
                'Select one more to diff'
              )}
            </span>
            <div className="row" style={{ gap: 6 }}>
              <Button
                variant="ghost"
                text="Clear"
                onClick={() => {
                  setSelected([])
                  setDiff(null)
                }}
              />
              <Button variant="primary" onClick={() => void runDiff()} disabled={selected.length !== 2 || diffBusy}>
                {diffBusy ? <Spinner /> : 'Diff'}
              </Button>
            </div>
          </div>
          {diff && (
            <>
              <DiffSection label="States" group={diff.states} />
              <DiffSection label="Events" group={diff.events} />
            </>
          )}
        </div>
      )}

      {/* Version tree */}
      <div style={{ marginTop: 14 }}>
        {loading && !versions && (
          <div className="muted" style={{ padding: '8px 0' }}>
            <Spinner /> loading versions…
          </div>
        )}

        {loadErr && (
          <div className="diag error">
            {loadErr}
            <div style={{ marginTop: 8 }}>
              <Button variant="ghost" text="Try again" onClick={() => void load()} />
            </div>
          </div>
        )}

        {!loadErr && versions && versions.length === 0 && (
          <div className="muted" style={{ fontSize: 12 }}>
            No snapshots yet — take one above to start a version history.
          </div>
        )}

        {!loadErr &&
          ordered.map(({ node: v, depth }) => {
            const selIdx = selected.indexOf(v.id)
            const busy = actionBusy === v.id
            const renaming = renamingId === v.id
            return (
              <div
                key={v.id}
                className="card"
                style={{
                  marginLeft: Math.min(depth, 4) * 12,
                  marginBottom: 6,
                  padding: 10,
                  borderColor: selIdx >= 0 ? 'var(--acc)' : undefined,
                }}
              >
                <div className="row" style={{ gap: 8, alignItems: 'flex-start' }}>
                  <Checkbox
                    label={`Select ${short(v.id)} to diff`}
                    checked={selIdx >= 0}
                    onChange={() => toggleSelect(v.id)}
                  />
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div className="row" style={{ gap: 6 }}>
                      <code title={v.id}>{short(v.id)}</code>
                      {selIdx >= 0 && <span className="badge public">{selIdx === 0 ? 'A' : 'B'}</span>}
                      {v.source && <Pill>{v.source}</Pill>}
                    </div>
                    {renaming ? (
                      <div style={{ marginTop: 6 }}>
                        <Field id="ver-rename-title" label="Title">
                          <TextInput
                            id="ver-rename-title"
                            value={renameText}
                            onChange={(e) => setRenameText(e.target.value)}
                            onKeyDown={(e) => {
                              if (e.key === 'Enter') {
                                e.preventDefault()
                                void saveRename(v)
                              } else if (e.key === 'Escape') {
                                setRenamingId(null)
                              }
                            }}
                            placeholder="Version title"
                            disabled={busy}
                            autoFocus
                          />
                        </Field>
                        <div className="row" style={{ gap: 6, marginTop: 6 }}>
                          <Button variant="primary" onClick={() => void saveRename(v)} disabled={busy}>
                            {busy ? <Spinner /> : 'Save'}
                          </Button>
                          <Button variant="ghost" text="Cancel" onClick={() => setRenamingId(null)} disabled={busy} />
                        </div>
                      </div>
                    ) : (
                      <div
                        style={{
                          marginTop: 2,
                          fontWeight: v.title ? 600 : 400,
                          whiteSpace: 'nowrap',
                          overflow: 'hidden',
                          textOverflow: 'ellipsis',
                          color: v.title ? 'var(--ink)' : 'var(--dim)',
                        }}
                        title={v.title ?? undefined}
                      >
                        {v.title || 'untitled'}
                      </div>
                    )}
                    {v.created_at && (
                      <div className="muted" style={{ fontSize: 11, marginTop: 2 }}>
                        {fmt(v.created_at)}
                      </div>
                    )}
                  </div>
                </div>

                {!renaming && (
                  <div className="row" style={{ gap: 6, marginTop: 8, flexWrap: 'wrap' }}>
                    <DangerButton
                      style={{ padding: '4px 9px', fontSize: 12 }}
                      confirm={`Restore snapshot ${short(v.id)}?\n\nThis replaces the current graph. Everything authored since then is lost.\n\nThe current graph will be snapshotted first, so you can get back to it.`}
                      onClick={() => void doCheckout(v)}
                      disabled={busy}
                    >
                      {busy ? <Spinner /> : 'Checkout'}
                    </DangerButton>
                    <Button
                      variant="ghost"
                      style={{ padding: '4px 9px', fontSize: 12 }}
                      text="Rename"
                      onClick={() => beginRename(v)}
                      disabled={busy}
                    />
                    <DangerButton
                      style={{ padding: '4px 9px', fontSize: 12 }}
                      confirm={`Prune version ${short(v.id)}? This can't be undone.`}
                      text="Prune"
                      onClick={() => void doDelete(v)}
                      disabled={busy}
                    />
                  </div>
                )}
              </div>
            )
          })}
      </div>
    </div>
  )
}
