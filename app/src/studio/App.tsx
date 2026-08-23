import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { AppConfig } from './config'
import { readUrlState, writeUrlState, type Section, type UrlState } from './url-state'
import { loadProviderConfig, saveProviderConfig } from '../provider'
import { isDeployedDemo } from './deploy-bootstrap'
import type { ProviderConfig } from '../provider'
import { ClientProvider } from './ClientContext'
import { Settings } from '../provider'
import { ApiLog } from './ApiLog'
import { Worlds } from '../world'
import { FloatingComposer } from '../author'
import { Community } from '../world'
import { Account } from '../account'
import { Book, GraphEditor } from '../author'
import { PlayModal } from '../play'
import { Reference } from '../tool'
import { Pill, Button, applyTheme, readStoredTheme, writeStoredTheme } from '../theme'

const NAV: { id: Section; label: string; icon: string }[] = [
  { id: 'creations', label: 'My Creations', icon: '▦' },
  // The book path worked from the CLI and had no door in the studio at all —
  // it earns a top-level item now that one exists.
  { id: 'book', label: 'Book → Game', icon: '◈' },
  { id: 'community', label: 'Community', icon: '◎' },
  { id: 'account', label: 'Account', icon: '◔' },
  { id: 'api', label: 'API', icon: '⌁' },
]

export function App() {
  const [providers, setProviders] = useState<ProviderConfig>(loadProviderConfig)
  /**
   * Bumped whenever a world is created. The composer FLOATS over the catalogue
   * now instead of being a page you navigate to, so the catalogue never
   * unmounts while you author — and a list that only loads on mount would show
   * a stale shelf with your brand-new world missing from it. Remounting on this
   * counter is what makes the new card appear where you are standing.
   */
  const [created, setCreated] = useState(0)
  const [settingsDirty, setSettingsDirty] = useState(false)

  // View state lives in the URL, not in four independent useStates. Every state
  // worth looking at is now reachable by parameter and linkable — see
  // app-url-state.ts for why that is a requirement rather than a nicety.
  const [url, setUrl] = useState<UrlState>(() => readUrlState(window.location.search))
  const section = url.section
  const editingId = url.worldId
  const playingId = url.playId
  const showSettings = url.settings

  const patchUrl = useCallback((patch: Partial<UrlState>) => {
    setUrl((prev) => {
      const next = { ...prev, ...patch }
      const search = writeUrlState(next)
      window.history.pushState(null, '', `${window.location.pathname}${search}`)
      return next
    })
  }, [])

  // Back/forward must move the studio, not just the address bar.
  useEffect(() => {
    const onPop = () => setUrl(readUrlState(window.location.search))
    window.addEventListener('popstate', onPop)
    return () => window.removeEventListener('popstate', onPop)
  }, [])

  // Leaving the editor drops its tab/selection params too — a URL carrying an
  // editor tab with no open editor would be junk state waiting to confuse.
  const setSection = useCallback((next: Section) => patchUrl({ section: next, worldId: null, tab: null, sel: null }), [patchUrl])
  const setEditingId = useCallback(
    (id: string | null) => patchUrl(id ? { worldId: id } : { worldId: null, tab: null, sel: null }),
    [patchUrl],
  )
  const setPlayingId = useCallback((id: string | null) => patchUrl({ playId: id }), [patchUrl])
  const setShowSettings = useCallback((open: boolean) => patchUrl({ settings: open }), [patchUrl])

  // Theme. Precedence: URL parameter (what makes screenshot runs deterministic)
  // over the persisted choice, over dark. The toggle is an explicit choice, so
  // it writes both the URL and the persisted slot; applyTheme stamps data-theme
  // on <html>, the attribute the palette in styles.css keys off.
  const [storedTheme, setStoredTheme] = useState(readStoredTheme)
  const theme = url.theme ?? storedTheme ?? 'dark'
  useEffect(() => {
    applyTheme(theme)
  }, [theme])
  const toggleTheme = useCallback(() => {
    const next = theme === 'light' ? 'dark' : 'light'
    setStoredTheme(next)
    writeStoredTheme(next)
    patchUrl({ theme: next })
  }, [theme, patchUrl])

  // The hosted API is now one provider among several, so its settings are a
  // slice of the provider config rather than the app's own identity.
  const config = useMemo<AppConfig>(
    () => ({
      apiBase: providers.world.alakazam.apiBase,
      embedHost: providers.world.alakazam.embedHost,
      apiKey: providers.world.alakazam.apiKey,
    }),
    [providers],
  )

  const applyProviders = (c: ProviderConfig) => { setProviders(saveProviderConfig(c)); setShowSettings(false) }

  // NO ENTRY GATE. The studio used to refuse to render until an sk_/pk_ key was
  // present, which meant a fresh clone opened on a login wall and the project's
  // central promise — that you can author and play a world with no account —
  // was false at the first screen. Everything degrades individually instead:
  // worlds fall back to this browser's storage, play falls back to the offline
  // mock, and AI authoring sits disabled until an LLM provider is configured.
  const worldLabel = providers.world.active

  // Something full-screen is covering the studio: the editor, the player, or
  // settings. The shell behind it must go INERT — not merely look covered.
  // Left interactive it kept a second, invisible copy of every control alive:
  // a catalogue card's Delete sat behind the editor's own Delete, reachable by
  // keyboard and announced by a screen reader, and the two were told apart only
  // by which one the pointer happened to hit first. React 18 has no `inert`
  // prop, so it is set through a ref on the element itself.
  const covered = editingId !== null || playingId !== null || showSettings
  const bodyRef = useRef<HTMLDivElement | null>(null)
  useEffect(() => {
    const el = bodyRef.current
    if (!el) return
    if (covered) el.setAttribute('inert', '')
    else el.removeAttribute('inert')
  }, [covered])

  return (
    <ClientProvider config={config} providers={providers}>
      <div className="studio">
        {/* CINEMA MODE. A play link (?play=) is a film, not a studio tour:
            with the player up there is no topbar, no rail, no log pane —
            the shell behind it stays mounted nowhere at all, so a judge
            pressing ▶ begin never meets the authoring surface. */}
        {!playingId && !isDeployedDemo() && (
        <>
        <header className="topbar">
          {/* Two runs, not one: "alakazam" carries the brand at live's own
              weight/size, "studio" stays a smaller subordinate suffix rather
              than running text at the same weight. Text content is unchanged
              ("ALAKAZAM STUDIO" as one accessible name) — the split is markup
              for independent sizing, not a copy change. */}
          <span className="brand" onClick={() => setSection('creations')}>
            <span className="brand-word">ALAKAZAM</span>{' '}
            <span className="brand-suffix">STUDIO</span>
          </span>
          <span className="spacer" />
          {/* Say what is actually driving the studio. The old pills showed an API
              base and a key prefix, which read as an error when there is no key —
              and no key is now a supported, normal state. One control, not two —
              the world provider and where it stores worlds are one fact to a
              creator, not two bordered chips. */}
          <Pill>
            world · {worldLabel} · worlds · {providers.world.alakazam.apiKey ? 'hosted' : 'this browser'}
          </Pill>
          <Button
            variant="ghost"
            onClick={toggleTheme}
            text={theme === 'light' ? '☾' : '☀'}
            aria-label="Toggle theme"
            title={`Switch to the ${theme === 'light' ? 'dark' : 'light'} theme`}
          />
          {/* Live marks its header's one primary CTA (Sign in) with the
              phosphor-green accent; every button here was neutral white-on-
              black, so the accent never once read as "call to action" outside
              the left-nav's active state. Settings is the studio's nearest
              equivalent — the header's own primary action — so it carries the
              accent, the same variant every other primary action already uses
              (Create's "Create world", Community's "Play"). */}
          <Button variant="primary" onClick={() => setShowSettings(true)} text="Settings" />
        </header>

        <div className="body" ref={bodyRef}>
          <nav className="rail">
            {NAV.map((n) => (
              <Button key={n.id} variant="ghost" className={'rail-item' + (section === n.id && !editingId ? ' on' : '')} onClick={() => setSection(n.id)}>
                <span className="rail-icon">{n.icon}</span> {n.label}
              </Button>
            ))}
          </nav>

          <main className="content">
            {(section === 'creations' || section === 'create') && (
              <Worlds key={created} onEdit={setEditingId} onPlay={setPlayingId} />
            )}
            {section === 'book' && <Book onPlay={setPlayingId} />}
            {section === 'community' && <Community onPlay={setPlayingId} />}
            {section === 'account' && <Account />}
            {section === 'api' && <Reference />}
          </main>

          <aside className="logpane"><ApiLog /></aside>
        </div>
        </>
        )}

        {/* The floating composer: "+ Create a new world" hovers over every
            section so creating is always one click away, not a page you have
            to navigate to. Hidden exactly where a floating copy of itself
            would be redundant or in the way — the create page already IS the
            composer, and the editor/play/settings overlays cover the whole
            screen anyway. */}
        {/* ONE create surface. The composer floats over whatever you are
            looking at — there is no Create page to navigate to, because
            authoring a world is a gesture you make from where you already are,
            not a destination. ?section=create still means something: it opens
            this expanded, so the state stays addressable and the screenshot
            harness can still drive straight to it. */}
        {!editingId && !playingId && !showSettings && (
          <FloatingComposer
            openOnMount={section === 'create'}
            onCreated={(id) => { setCreated((n) => n + 1); setEditingId(id) }}
          />
        )}

        {editingId && (
          <GraphEditor
            worldId={editingId}
            tab={url.tab}
            sel={url.sel}
            onNavigate={patchUrl}
            onClose={() => setEditingId(null)}
            onPlay={setPlayingId}
          />
        )}
        {playingId && (
          <PlayModal
            locked={isDeployedDemo()}
            worldId={playingId}
            campaignId={url.campaignId ?? undefined}
            startState={url.playState ?? undefined}
            variant={url.playVariant ?? undefined}
            onClose={() => setPlayingId(null)}
          />
        )}
        {showSettings && (
          <div
            className="modal-scrim"
            onClick={() => {
              // An accidental click on the backdrop must not throw away a key the
              // user just pasted and tested. Only unedited settings close freely.
              if (!settingsDirty || window.confirm('Discard your unsaved provider settings?')) {
                setSettingsDirty(false)
                setShowSettings(false)
              }
            }}
          >
            <div onClick={(e) => e.stopPropagation()}>
              <Settings
                config={providers}
                onSave={applyProviders}
                onClose={() => { setSettingsDirty(false); setShowSettings(false) }}
                onDirtyChange={setSettingsDirty}
              />
            </div>
          </div>
        )}
      </div>
    </ClientProvider>
  )
}
