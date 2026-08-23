import { useCallback, useEffect, useMemo, useState } from 'react'
import { useClient } from '../studio'
import type { EditorPanelProps, EditorSelection } from './types'
import type { Diagnostic, SMWorld } from '../world'
import { autoFixOps, runDoctrine, toApiFailure, unwrapWorldDoc } from '../world'
import { Inspector } from './Inspector'
import { AgentBar } from './agent/AgentBar'
import { LintPanel } from './Lint'
import { VersionsPanel } from './Versions'
import { VisionPanel } from './Vision'
import { Button, Diag, Spinner, useToast } from '../theme'
import { GraphCanvas } from './GraphCanvas'
import { clearLayout, readLayout, saveNodePosition } from './layout'
import { Ftue, hasSeenFtue } from './Ftue'
import type { XY } from './layout'
import { DoctrineLints } from './DoctrineLints'

/**
 * GraphEditor — the full-screen editor shell for one world.
 *
 * Loads getWorld (name/cover/entrance) + getScene (states/events/rev) on mount,
 * owns the world/rev/selection/toast state, renders a defensive SVG graph on the
 * LEFT (states = nodes on a circle, transition events = labelled edges), and a
 * tabbed sidebar of sub-panels on the RIGHT. Sub-panels do the graph writes —
 * they receive `rev` (pass as ifMatch), `reload` (call after a write / on 409),
 * `toast`, `selected`, and `select` via EditorPanelProps.
 */
export function GraphEditor({
  worldId,
  tab: tabParam,
  sel: selParam,
  onNavigate,
  onClose,
  onPlay,
}: {
  worldId: string
  /** Editor tab from the URL; opaque string there, validated here. */
  tab: string | null
  /** Selection from the URL as `state:<id>` / `event:<name>`; validated here. */
  sel: string | null
  /** Write tab/selection back to the URL — the single owner of view state. */
  onNavigate: (patch: { tab?: string | null; sel?: string | null }) => void
  onClose: () => void
  onPlay: (worldId: string) => void
}) {
  const { client, store, tools } = useClient()

  const [world, setWorld] = useState<SMWorld | null>(null)
  /** Cards a person dragged, for THIS world. Editor state, persisted beside
   *  the world rather than inside it — see `./layout.ts`. */
  const [tour, setTour] = useState(() => !hasSeenFtue())
  const [layout, setLayout] = useState<Record<string, XY>>(() => readLayout(worldId))
  useEffect(() => { setLayout(readLayout(worldId)) }, [worldId])
  const [rev, setRev] = useState<string>('')
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const { toast, toastEl } = useToast()

  // Tab and selection LIVE IN THE URL — the editor holds no state of its own
  // for them, so ?world=…&tab=versions&sel=state:lane opens exactly that view
  // (the screenshot harness depends on it) and back/forward walks the history
  // of what was looked at. This module owns the VOCABULARY: an unknown tab
  // falls back to the inspector, a malformed selection is no selection.
  const tab: Tab = isTab(tabParam) ? tabParam : 'inspector'
  const setTab = useCallback((t: Tab) => onNavigate({ tab: t }), [onNavigate])
  const selected = useMemo(() => parseSelection(selParam), [selParam])
  const select = useCallback((sel: EditorSelection) => onNavigate({ sel: serializeSelection(sel) }), [onNavigate])

  // Fetch scene (source of truth for states/events/rev) + world (name/cover/entrance).
  const fetchAll = useCallback(async () => {
    const [scene, w] = await Promise.all([store.getScene(worldId), store.getWorld(worldId)])
    const base = unwrapWorldDoc(w)
    setWorld({ ...base, id: worldId, scene: { states: scene.states, events: scene.events } })
    setRev(scene.rev)
  }, [client, worldId])

  /** Re-fetch world+scene from /v1 and refresh rev. Sub-panels call this after any write / on 409. */
  const reload = useCallback(async () => {
    try {
      await fetchAll()
    } catch (e) {
      toast(toApiFailure(e).detail, true)
    }
  }, [fetchAll, toast])

  useEffect(() => {
    let alive = true
    setLoading(true)
    setError(null)
    fetchAll()
      .catch((e) => {
        if (!alive) return
        setError(toApiFailure(e).detail)
      })
      .finally(() => {
        if (alive) setLoading(false)
      })
    return () => {
      alive = false
    }
  }, [fetchAll])

  const panelProps: EditorPanelProps | null = useMemo(
    () => (world ? { worldId, world, rev, reload, selected, select, toast } : null),
    [world, worldId, rev, reload, selected, select, toast],
  )

  // The local doctrine (`../world`'s `runDoctrine`) run over the loaded world —
  // memoised on `world` itself so it reruns once per load/reload, not on every
  // tab switch or selection change. Feeds BOTH the canvas (node/edge colour)
  // and the lints panel below: one doctrine pass, two views of the same list.
  const diagnostics = useMemo(() => (world ? runDoctrine(world) : []), [world])
  // The lint panel's one-click Fix. It goes through the SAME `author.ops` leaf
  // every other write in this editor uses — a panel that hand-patched the world
  // would be a second way to write a graph, and the one that skips validation.
  const [fixing, setFixing] = useState<string | null>(null)
  async function applyFix(d: Diagnostic): Promise<void> {
    if (!world || fixing) return
    const ops = autoFixOps(world, d)
    if (ops.length === 0) return
    const key = `${d.lint}:${d.path}`
    setFixing(key)
    try {
      const outcome = await tools.run('author.ops', { world: worldId, ops, rev })
      if (outcome.ok) {
        await reload()
        toast('fixed')
      } else if (outcome.error.conflict) {
        await reload()
        toast('reload & retry', true)
      } else {
        toast(outcome.error.message || 'fix failed', true)
      }
    } finally {
      setFixing(null)
    }
  }

  const stateCount = world ? Object.keys(world.scene?.states ?? {}).length : 0
  const eventCount = world ? (world.scene?.events ?? []).length : 0
  /** A seed frame exists. Read off the world, not the provider, so the note is
   *  a fact about what was authored rather than a guess about who will play it. */
  const hasFirstFrame = !world || Boolean(world.entrance?.image?.src)
  const errorCount = diagnostics.filter((d) => d.severity === 'error').length
  const warningCount = diagnostics.filter((d) => d.severity === 'warning').length

  return (
    <div className="overlay">
      <div className="overlay-head">
        <strong style={{ maxWidth: 420, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {world?.name || worldId}
        </strong>
        {world && (
          <span className="muted" style={{ fontSize: 12 }}>
            {stateCount} states · {eventCount} events
            {errorCount > 0 && (
              <span style={{ color: 'var(--err)' }}> · {errorCount} error{errorCount === 1 ? '' : 's'}</span>
            )}
            {warningCount > 0 && (
              <span style={{ color: 'var(--warn)' }}> · {warningCount} warning{warningCount === 1 ? '' : 's'}</span>
            )}
            {/* NO FIRST FRAME. Not a doctrine lint — the doctrine judges the
                world, and a world without a seed frame is perfectly valid on a
                backend that does not need one (the mock, an echo server, any
                text-seeded model). It is a PROVIDER fact, and the only place it
                was ever said was after `connect()`, in a banner over a black
                screen. An iteration lost a whole live session
                to exactly that: authored, pressed Play, and sat in front of
                nothing while the session cheerfully accepted every beat. Saying
                it here costs a span and saves the trip. */}
            {!hasFirstFrame && (
              <span style={{ color: 'var(--warn)' }} title="Some world models continue from a picture and will not start from prose alone (lingbot-world-2 is one). Generate again, or paint an entrance image, if the picture stays black.">
                {' '}· no first frame
              </span>
            )}
          </span>
        )}
        {loading && <Spinner />}
        <span className="spacer" />
        <Button variant="ghost" text="?" title="show the editor tour again" aria-label="Show the editor tour" onClick={() => setTour(true)} />
        <Button variant="primary" text="▶ Play" onClick={() => onPlay(worldId)} />
        <Button variant="ghost" text="Close" onClick={onClose} />
      </div>

      {/* THE TOUR. Shown once, on the first editor a person opens; the `?`
          above brings it back. 35 iterations of mechanics are worth very little
          to someone who cannot find them. */}
      {tour && <Ftue onClose={() => setTour(false)} />}

      <div style={{ flex: 1, display: 'flex', minHeight: 0 }}>
        {/* LEFT: graph */}
        <div
          style={{
            flex: 1,
            minWidth: 0,
            position: 'relative',
            overflow: 'hidden',
            borderRight: '1px solid var(--line)',
            background: 'var(--bg)',
          }}
        >
          {error && (
            <div style={{ padding: 24 }}>
              <Diag kind="error">{error}</Diag>
              <Button variant="ghost" text="Retry" style={{ marginTop: 10 }} onClick={() => void reload()} />
            </div>
          )}
          {!error && loading && !world && <div className="empty">loading graph…</div>}
          {!error && world && (
            <>
              <GraphCanvas
                states={world.scene?.states ?? {}}
                events={world.scene?.events ?? []}
                cutscenes={world.cutscenes ?? []}
                entrance={world.entrance?.state}
                selected={selected}
                onSelect={select}
                diagnostics={diagnostics}
                layout={layout}
                onMoveNode={(id, at) => setLayout(saveNodePosition(worldId, id, at))}
              />
              {Object.keys(layout).length > 0 && (
                <Button
                  className="layout-reset"
                  variant="ghost"
                  text="↺ auto-layout"
                  title="forget the positions you dragged and lay the graph out automatically again"
                  onClick={() => { clearLayout(worldId); setLayout({}) }}
                />
              )}
              <DoctrineLints
                diagnostics={diagnostics}
                onSelect={select}
                fixing={fixing}
                onFix={(d) => void applyFix(d)}
              />
              <div
                className="muted"
                style={{ position: 'absolute', bottom: 10, left: 12, fontSize: 11, pointerEvents: 'none' }}
              >
                <span style={{ color: 'var(--acc)' }}>▶ entrance</span> ·{' '}
                <span style={{ color: 'var(--err)' }}>■ ending</span> · click a node or an edge label to edit
              </div>
              {/* The kernel agent lives ON the canvas, the way it does on the
                  platform — a bar you talk to while looking at the graph, not a
                  tab you leave the graph to visit. */}
              {panelProps && <AgentBar {...panelProps} startCollapsed={diagnostics.length > 0} />}
            </>
          )}
        </div>

        {/* RIGHT: tabbed sub-panels */}
        <div style={{ width: 360, flex: 'none', display: 'flex', flexDirection: 'column', minHeight: 0 }}>
          <div className="tabs" style={{ padding: '10px 12px', borderBottom: '1px solid var(--line)' }}>
            {TABS.map((t) => (
              <Button key={t.id} className={tab === t.id ? 'on' : ''} onClick={() => setTab(t.id)} text={t.label} />
            ))}
          </div>
          <div style={{ flex: 1, overflow: 'auto', padding: 12, minHeight: 0 }}>
            {panelProps ? (
              <>
                {tab === 'inspector' && <Inspector {...panelProps} />}
                {tab === 'validate' && <LintPanel {...panelProps} />}
                {tab === 'versions' && <VersionsPanel {...panelProps} />}
                {tab === 'vision' && <VisionPanel {...panelProps} />}
              </>
            ) : (
              <div className="muted" style={{ marginTop: 24 }}>
                {error ? 'world failed to load' : 'loading…'}
              </div>
            )}
          </div>
        </div>
      </div>

      {toastEl}
    </div>
  )
}

type Tab = 'inspector' | 'validate' | 'versions' | 'vision'

function isTab(v: string | null): v is Tab {
  return v !== null && TABS.some((t) => t.id === v)
}

/** `state:<id>` / `event:<name>` → a selection. Total: anything else is null,
 *  because a hand-edited URL must degrade to "nothing selected", not break. */
function parseSelection(v: string | null): EditorSelection {
  if (!v) return null
  const idx = v.indexOf(':')
  if (idx <= 0) return null
  const kind = v.slice(0, idx)
  const ref = v.slice(idx + 1)
  if (!ref) return null
  if (kind === 'state') return { kind: 'state', id: ref }
  if (kind === 'event') return { kind: 'event', name: ref }
  return null
}

function serializeSelection(sel: EditorSelection): string | null {
  if (!sel) return null
  return sel.kind === 'state' ? `state:${sel.id}` : `event:${sel.name}`
}

const TABS: { id: Tab; label: string }[] = [
  { id: 'inspector', label: 'Inspector' },
  { id: 'validate', label: 'Validate' },
  { id: 'versions', label: 'Versions' },
  { id: 'vision', label: 'Vision' },
]
