import { useCallback, useEffect, useState } from 'react'
import { useClient } from '../studio'
import type { WorldListItem } from './types'
import { Button, Pill, Spinner, Diag, useToast } from '../theme'
import { toApiFailure } from './failure'
import { WorldCard } from './WorldCard'

/** Read-only gallery of THIS app's PUBLIC worlds — the single-tenant "community"
 *  (no cross-tenant discovery exists on /v1). It's just `listWorlds()` filtered
 *  to `visibility === 'public'`, so players can see and share what's live.
 *  Play hands off to the parent (PlayModal); Copy-link mints a session + embed URL. */
export function Community({ onPlay }: { onPlay: (worldId: string) => void }) {
  const { client, embedHost, store } = useClient()
  const [worlds, setWorlds] = useState<WorldListItem[] | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [busyId, setBusyId] = useState<string | null>(null)
  const { toast, toastEl } = useToast()

  const reload = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      // Page through every world so the public gallery is complete, then filter.
      const all: WorldListItem[] = []
      let cursor: string | undefined
      let guard = 0
      do {
        const res = await store.listWorlds({ limit: 100, cursor })
        all.push(...res.worlds)
        cursor = res.nextCursor ?? undefined
        guard += 1
      } while (cursor && guard < 50)
      setWorlds(all.filter((w) => w.visibility === 'public'))
    } catch (e) {
      setError(toApiFailure(e).detail)
      setWorlds(null)
    } finally {
      setLoading(false)
    }
  }, [client])

  useEffect(() => {
    void reload()
  }, [reload])

  const copyLink = useCallback(async (worldId: string) => {
    setBusyId(worldId)
    try {
      const session = await client.mintSession({ worldId })
      const url = client.embedUrl(embedHost, session.token)
      const ok = await copyToClipboard(url)
      toast(ok ? 'Play link copied to clipboard' : 'Could not access clipboard — check permissions', !ok)
    } catch (e) {
      toast(toApiFailure(e).detail, true)
    } finally {
      setBusyId(null)
    }
  }, [client, embedHost, toast])

  return (
    <div>
      <div className="row" style={{ justifyContent: 'space-between', alignItems: 'flex-end', marginBottom: 4 }}>
        <div>
          <h2>Community</h2>
          <p className="muted" style={{ margin: 0 }}>Your app's public worlds — what your players can discover.</p>
        </div>
        <div className="row">
          {worlds && <Pill>{worlds.length} public</Pill>}
          <Button variant="ghost" text="Refresh" onClick={() => void reload()} disabled={loading} />
        </div>
      </div>

      {loading && (
        <div className="empty"><Spinner /> loading public worlds…</div>
      )}

      {!loading && error && (
        <div className="card" style={{ marginTop: 16 }}>
          <Diag kind="error">{error}</Diag>
          <Button variant="ghost" style={{ marginTop: 10 }} text="Try again" onClick={() => void reload()} />
        </div>
      )}

      {!loading && !error && worlds && worlds.length === 0 && (
        <div className="empty">
          No public worlds yet.<br />
          <span className="muted">Set a world's visibility to <span className="badge public">public</span> in My Creations and it shows up here.</span>
        </div>
      )}

      {!loading && !error && worlds && worlds.length > 0 && (
        <div className="grid" style={{ marginTop: 16 }}>
          {worlds.map((w) => (
            <WorldCard
              key={w.id}
              item={w}
              meta={
                <>
                  <div className="row" style={{ justifyContent: 'space-between', gap: 8 }}>
                    <span className="title" title={w.name}>{w.name || 'Untitled world'}</span>
                    <span className="badge public">public</span>
                  </div>
                  {w.description && (
                    <span className="muted" style={{ fontSize: 12, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }} title={w.description}>
                      {w.description}
                    </span>
                  )}
                </>
              }
              actions={
                <>
                  <Button variant="primary" text="Play" onClick={() => onPlay(w.id)} />
                  <Button
                    variant="ghost"
                    busy={busyId === w.id}
                    text={busyId === w.id ? '' : 'Copy link'}
                    onClick={() => void copyLink(w.id)}
                    disabled={busyId === w.id}
                  />
                </>
              }
            />
          ))}
        </div>
      )}

      {toastEl}
    </div>
  )
}

/** Copy text to the clipboard, falling back to execCommand for insecure contexts. */
async function copyToClipboard(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text)
      return true
    }
  } catch {
    /* fall through to legacy path */
  }
  try {
    const ta = document.createElement('textarea')
    ta.value = text
    ta.style.position = 'fixed'
    ta.style.opacity = '0'
    document.body.appendChild(ta)
    ta.select()
    const ok = document.execCommand('copy')
    document.body.removeChild(ta)
    return ok
  } catch {
    return false
  }
}
