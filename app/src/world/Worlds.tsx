import { useCallback, useEffect, useState } from 'react'
import { useClient } from '../studio'
import type { WorldListItem } from './types'
import type { ToolFailure } from '../tool'
import { Button, DangerButton, Spinner, useToast } from '../theme'
import { toApiFailure } from './failure'
import { WorldCard } from './WorldCard'

const PAGE = 24
// Visibility cycles private → unlisted → public → private on each toggle.
const VIS_CYCLE = ['private', 'unlisted', 'public'] as const

/** Human-friendly "updated" stamp from an ISO string. */
function fmtWhen(iso?: string): string {
  if (!iso) return ''
  const t = new Date(iso).getTime()
  if (Number.isNaN(t)) return ''
  const sec = Math.round((Date.now() - t) / 1000)
  if (sec < 60) return 'just now'
  const min = Math.round(sec / 60)
  if (min < 60) return `${min}m ago`
  const hr = Math.round(min / 60)
  if (hr < 24) return `${hr}h ago`
  const day = Math.round(hr / 24)
  if (day < 30) return `${day}d ago`
  return new Date(t).toLocaleDateString()
}

function nextVisibility(current?: string): string {
  const i = (VIS_CYCLE as readonly string[]).indexOf(current ?? 'private')
  return VIS_CYCLE[(i < 0 ? 0 : i + 1) % VIS_CYCLE.length] ?? 'private'
}

/**
 * The creator's own worlds: a grid of listWorlds() with per-card lifecycle
 * actions (Play, Edit, Fork, Share, Delete, visibility toggle). Single-tenant —
 * the API key IS the creator, so every world here is theirs to mutate.
 */
/** A tool outcome's value, narrowly. */
function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

export function Worlds({ onEdit, onPlay }: { onEdit: (worldId: string) => void; onPlay: (worldId: string) => void }) {
  const { client, store, tools, embedHost, providers } = useClient()
  // World CRUD goes to the STORE — hosted when a key is configured, this
  // browser otherwise — so the grid works before anyone has an account.
  // `client` stays for share links, which only a hosted world can have.
  const hosted = !!providers.world.alakazam.apiKey
  const [worlds, setWorlds] = useState<WorldListItem[]>([])
  const [cursor, setCursor] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [loadingMore, setLoadingMore] = useState(false)
  const [error, setError] = useState<string | null>(null)
  // Per-world in-flight action name (fork/share/delete/visibility) → disables + spins that card.
  const [busy, setBusy] = useState<Record<string, string | undefined>>({})
  const { toast, toastEl } = useToast()

  const reload = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const res = await store.listWorlds({ limit: PAGE })
      setWorlds(res.worlds)
      setCursor(res.nextCursor ?? null)
    } catch (e) {
      setError(toApiFailure(e).detail)
    } finally {
      setLoading(false)
    }
  }, [client])

  useEffect(() => { void reload() }, [reload])

  const loadMore = useCallback(async () => {
    if (!cursor) return
    setLoadingMore(true)
    try {
      const res = await store.listWorlds({ limit: PAGE, cursor })
      setWorlds((prev) => [...prev, ...res.worlds])
      setCursor(res.nextCursor ?? null)
    } catch (e) {
      toast(toApiFailure(e).detail, true)
    } finally {
      setLoadingMore(false)
    }
  }, [client, cursor, toast])

  // Shared error handler for the still-direct paths (share). 409 (concurrent
  // edit elsewhere) → reload + advise retry.
  const onError = useCallback((e: unknown, fallback: string) => {
    const failure = toApiFailure(e)
    if (failure.status === 409) { void reload(); toast('reload & retry', true); return }
    toast(failure.detail || fallback, true)
  }, [reload, toast])

  // Same shared behaviour, for tool-bridge outcomes: a conflict reloads and
  // advises retry, anything else surfaces the tool's message or the fallback.
  const onOutcomeError = useCallback((error: ToolFailure, fallback: string) => {
    if (error.conflict) { void reload(); toast('reload & retry', true); return }
    toast(error.message || fallback, true)
  }, [reload, toast])

  const setWorldBusy = (id: string, action: string | undefined) => setBusy((b) => ({ ...b, [id]: action }))

  const doFork = useCallback(async (id: string) => {
    setWorldBusy(id, 'fork')
    try {
      const outcome = await tools.run('world.fork', { id })
      if (!outcome.ok) { onOutcomeError(outcome.error, 'Fork failed'); return }
      toast('Forked — added to your creations')
      await reload()
    } finally {
      setWorldBusy(id, undefined)
    }
  }, [tools, reload, toast, onOutcomeError])

  const doShare = useCallback(async (id: string) => {
    setWorldBusy(id, 'share')
    try {
      const session = await client.mintSession({ worldId: id })
      const url = client.embedUrl(embedHost, session.token)
      let copied = false
      try {
        if (navigator.clipboard?.writeText) { await navigator.clipboard.writeText(url); copied = true }
      } catch { copied = false }
      toast(copied ? 'Share link copied to clipboard' : url)
    } catch (e) {
      onError(e, 'Could not create share link')
    } finally {
      setWorldBusy(id, undefined)
    }
  }, [client, embedHost, toast, onError])

  // No confirm here: the DangerButton at the call site owns the confirmation.
  // Both layers asking (as a migration briefly did) means every delete answers
  // the same dialog twice — the e2e that drives dialogs is what caught it.
  const doDelete = useCallback(async (w: WorldListItem) => {
    setWorldBusy(w.id, 'delete')
    try {
      const outcome = await tools.run('world.delete', { id: w.id })
      if (!outcome.ok) { onOutcomeError(outcome.error, 'Delete failed'); return }
      setWorlds((prev) => prev.filter((x) => x.id !== w.id))
      // Say what it cost. A world can be an ACT of a campaign, and deleting it
      // leaves that story with a hole in the middle — reported rather than
      // repaired, so the author decides what happens to the act.
      const broke = outcome.ok && isRecord(outcome.value) && Array.isArray(outcome.value['brokeCampaigns'])
        ? outcome.value['brokeCampaigns'].filter((t): t is string => typeof t === 'string')
        : []
      toast(broke.length > 0 ? `Deleted — ${broke.join(', ')} now has an act with no world` : 'Deleted', broke.length > 0)
    } finally {
      setWorldBusy(w.id, undefined)
    }
  }, [tools, toast, onOutcomeError])

  const doToggleVisibility = useCallback(async (w: WorldListItem) => {
    const next = nextVisibility(w.visibility)
    setWorldBusy(w.id, 'visibility')
    try {
      const outcome = await tools.run('world.update', { id: w.id, visibility: next })
      if (!outcome.ok) { onOutcomeError(outcome.error, 'Could not change visibility'); return }
      setWorlds((prev) => prev.map((x) => (x.id === w.id ? { ...x, visibility: next } : x)))
      toast(`Visibility → ${next}`)
    } finally {
      setWorldBusy(w.id, undefined)
    }
  }, [tools, toast, onOutcomeError])

  return (
    <div>
      <div className="row" style={{ marginBottom: 14 }}>
        <h2 style={{ margin: 0 }}>My Creations</h2>
        <span className="spacer" />
        <Button variant="ghost" text="Refresh" onClick={() => void reload()} disabled={loading} />
      </div>

      {loading && <div className="empty"><Spinner /> Loading your worlds…</div>}

      {!loading && error && (
        <div className="diag error">
          {error}
          <Button variant="ghost" style={{ marginLeft: 8 }} text="Retry" onClick={() => void reload()} />
        </div>
      )}

      {!loading && !error && worlds.length === 0 && (
        <div className="empty">
          <div style={{ fontSize: 15, marginBottom: 6 }}>No creations yet</div>
          <div className="muted">Head to <strong>Create</strong> to author your first world.</div>
        </div>
      )}

      {!loading && !error && worlds.length > 0 && (
        <>
          <div className="grid">
            {worlds.map((w) => {
              const vis = w.visibility ?? 'private'
              const busyAction = busy[w.id]
              const isBusy = !!busyAction
              return (
                <WorldCard
                  key={w.id}
                  item={w}
                  meta={
                    <>
                      <div className="title" title={w.name || 'Untitled'}>{w.name || 'Untitled'}</div>
                      <div className="row" style={{ gap: 8 }}>
                        <span
                          className={'badge' + (vis === 'public' ? ' public' : vis === 'unlisted' ? ' unlisted' : '')}
                          role="button"
                          title={`Visibility: ${vis} — click to cycle`}
                          onClick={() => { if (!isBusy) void doToggleVisibility(w) }}
                          style={{ cursor: isBusy ? 'default' : 'pointer' }}
                        >
                          {busyAction === 'visibility' ? <Spinner /> : vis}
                        </span>
                        <span className="spacer" />
                        <span className="muted" style={{ fontSize: 11 }}>{fmtWhen(w.updated_at)}</span>
                      </div>
                    </>
                  }
                  actions={
                    <>
                      <Button text="Play" onClick={() => onPlay(w.id)} disabled={isBusy} />
                      <Button text="Edit" onClick={() => onEdit(w.id)} disabled={isBusy} />
                      <Button
                        variant="ghost"
                        busy={busyAction === 'fork'}
                        text={busyAction === 'fork' ? '' : 'Fork'}
                        onClick={() => void doFork(w.id)}
                        disabled={isBusy}
                      />
                      {/* A share link is a signed URL into the hosted runtime, so
                          there is nothing to share for a world that only exists in
                          this browser. Disabled and explained beats a button that
                          fails when pressed. */}
                      <Button
                        variant="ghost"
                        busy={busyAction === 'share'}
                        text={busyAction === 'share' ? '' : 'Share'}
                        onClick={() => void doShare(w.id)}
                        disabled={isBusy || !hosted}
                        title={hosted ? undefined : 'Share links need a hosted world — add an Alakazam key in Settings'}
                      />
                      <DangerButton
                        confirm={`Delete "${w.name || 'Untitled'}"? This can't be undone.`}
                        busy={busyAction === 'delete'}
                        text={busyAction === 'delete' ? '' : 'Delete'}
                        onClick={() => void doDelete(w)}
                        disabled={isBusy}
                      />
                    </>
                  }
                />
              )
            })}
          </div>

          {cursor && (
            <div className="row" style={{ justifyContent: 'center', marginTop: 16 }}>
              <Button
                variant="ghost"
                busy={loadingMore}
                text={loadingMore ? 'Loading…' : 'Load more'}
                onClick={() => void loadMore()}
                disabled={loadingMore}
              />
            </div>
          )}
        </>
      )}

      {toastEl}
    </div>
  )
}
