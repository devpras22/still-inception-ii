import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
// Namespace import: the registry exports free functions, and this keeps the call
// sites reading as registry.capabilityWarning() without coupling to a wrapper object.
import * as registry from './registry'
import { LLM_PRESETS, type LLMPreset } from './llm/presets'
import { NO_CAPABILITIES, type ProviderConfig, type WorldCapabilities } from './types'
import { CapabilityBadge } from './CapabilityBadge'
import { Button, Field, Select, TextInput } from '../theme'

/**
 * Where you plug in your own things.
 *
 * Two independent choices, deliberately kept apart on screen because they fail
 * separately: what DRAWS the world, and what WRITES it. You can run your own
 * Reactor key with someone else's LLM, or a local Ollama with the hosted
 * renderer, and neither one knows about the other.
 *
 * This panel owns no persistence. It edits a draft and hands it back through
 * onSave, so the parent stays the only writer to localStorage and this file
 * cannot disagree with it about what "saved" means. The one exception is "Clear
 * keys", which erases storage directly — a request to delete a secret should
 * take effect when it is made, not when someone remembers to press Save.
 *
 * Both Test buttons probe the DRAFT rather than the saved config — testing a key
 * you have not saved yet is the entire point of a test button.
 */

interface Props {
  config: ProviderConfig
  onSave: (config: ProviderConfig) => void
  onClose?: () => void
  /** Fires whenever the draft diverges from (or returns to) the saved config. */
  onDirtyChange?: (dirty: boolean) => void
}

type Endpoint = ProviderConfig['llm']['endpoints'][string]

const KEY_SHAPE = /^(pk|sk)_(test|live)_/

/** Flatten anything thrown into one line, keeping the HTTP status when there is one. */
function errText(e: unknown): string {
  if (e instanceof Error) {
    const status = (e as { status?: number }).status
    return status ? `${e.message} [${status}]` : e.message
  }
  return String(e)
}

function isAbort(e: unknown): boolean {
  return e instanceof Error && e.name === 'AbortError'
}

/** Enough to attempt a connection. Not a promise that it works — that is what probing is for. */
function worldReady(w: ProviderConfig['world']): boolean {
  switch (w.active) {
    case 'mock':
      return true
    case 'reactor':
      return w.reactor.apiKey.trim().length > 0
    case 'websocket':
      return /^wss?:\/\//i.test(w.websocket.url.trim())
    case 'alakazam':
      return w.alakazam.apiKey.trim().length > 0 && w.alakazam.apiBase.trim().length > 0
  }
}

/**
 * The row backing the fields, invented from the preset the first time it is
 * shown. Deliberately NOT registry.llmEndpoint(): that normalises the URL, and
 * normalising inside a controlled input eats the slash the moment you type it.
 * Values are cleaned on save instead, where nobody is mid-keystroke.
 */
function endpointFor(cfg: ProviderConfig, id: string): Endpoint {
  const saved = cfg.llm.endpoints[id]
  if (saved) return saved
  const p = LLM_PRESETS.find((x) => x.id === id)
  return { baseUrl: p?.baseUrl ?? '', apiKey: '', model: p?.defaultModel ?? '' }
}

/**
 * Host only, so a key field can name the exact machine its contents are handed
 * to. "Sent to api.groq.com" is checkable in a way that "sent to your provider"
 * is not, and the whole point of the sentence is that it can be checked.
 */
function hostOf(url: string, fallback: string): string {
  const raw = url.trim()
  if (!raw) return fallback
  try {
    return new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ? raw : `https://${raw}`).host || fallback
  } catch {
    return fallback // half-typed URL: say something true rather than something wrong
  }
}

/** Trailing slashes make `//chat/completions`, which some gateways answer with a 404. */
function trimBase(s: string): string {
  const t = s.trim()
  return t.endsWith('://') ? t : t.replace(/\/+$/, '')
}

export function Settings({ config, onSave, onClose, onDirtyChange }: Props) {
  const [draft, setDraft] = useState<ProviderConfig>(config)

  /**
   * This panel owns no persistence: it edits a draft and hands it back on save.
   * That made an accidental click on the scrim silently destructive — paste a
   * Reactor key, press Test connection, watch it come back green, click the dark
   * area instead of Save, and the key is gone back to the vendor dashboard.
   * Nothing was written and nothing warned. Tell the parent when there is
   * something to lose so it can ask before discarding it.
   */
  const dirty = useMemo(() => JSON.stringify(draft) !== JSON.stringify(config), [draft, config])
  useEffect(() => { onDirtyChange?.(dirty) }, [dirty, onDirtyChange])

  const [probing, setProbing] = useState(false)
  const [confirmingReset, setConfirmingReset] = useState(false)
  const [caps, setCaps] = useState<WorldCapabilities | null>(null)
  const [probeErr, setProbeErr] = useState<string | null>(null)

  const [testingLlm, setTestingLlm] = useState(false)
  const [llmResult, setLlmResult] = useState<{ ok: boolean; text: string } | null>(null)
  const [models, setModels] = useState<string[] | null>(null)
  const [loadingModels, setLoadingModels] = useState(false)

  const worldAbort = useRef<AbortController | null>(null)
  const llmAbort = useRef<AbortController | null>(null)
  useEffect(() => () => {
    worldAbort.current?.abort()
    llmAbort.current?.abort()
  }, [])

  const world = draft.world
  const activeLlm = draft.llm.active
  const preset: LLMPreset | undefined = LLM_PRESETS.find((p) => p.id === activeLlm)
  const endpoint = endpointFor(draft, activeLlm)

  /** Any world edit invalidates the last probe — a stale capability row is worse than none. */
  function patchWorld(patch: Partial<ProviderConfig['world']>) {
    setDraft((d) => ({ ...d, world: { ...d.world, ...patch } }))
    setCaps(null)
    setProbeErr(null)
  }

  function selectPreset(id: string) {
    setDraft((d) => ({
      ...d,
      llm: {
        active: id,
        // Seed from the preset only the first time it is picked. Re-picking must not
        // wipe an endpoint the user has edited — their key for that vendor lives in it.
        endpoints: !id || d.llm.endpoints[id] ? d.llm.endpoints : { ...d.llm.endpoints, [id]: endpointFor(d, id) },
      },
    }))
    setLlmResult(null)
    setModels(null)
  }

  function patchImage(patch: Partial<ProviderConfig['image']>) {
    setDraft((d) => ({ ...d, image: { ...d.image, ...patch } }))
  }

  function patchVision(patch: Partial<ProviderConfig['vision']>) {
    setDraft((d) => ({ ...d, vision: { ...d.vision, ...patch } }))
  }

  function patchEndpoint(patch: Partial<Endpoint>) {
    if (!activeLlm) return
    setDraft((d) => ({
      ...d,
      llm: { ...d.llm, endpoints: { ...d.llm.endpoints, [d.llm.active]: { ...endpointFor(d, d.llm.active), ...patch } } },
    }))
    setLlmResult(null)
    // A model list belongs to one endpoint; keeping it across a URL edit would offer
    // the old server's models for the new one.
    if (patch.baseUrl !== undefined || patch.apiKey !== undefined) setModels(null)
  }

  async function testWorld() {
    worldAbort.current?.abort()
    const ac = new AbortController()
    worldAbort.current = ac
    setProbing(true)
    setProbeErr(null)
    try {
      setCaps(await registry.getWorldProvider(draft).probe(ac.signal))
    } catch (e) {
      if (isAbort(e)) return
      // The contract says probe() never throws. One that does is still the user's
      // problem to see, so surface it instead of swallowing it into a blank row.
      setCaps(NO_CAPABILITIES)
      setProbeErr(errText(e))
    } finally {
      if (!ac.signal.aborted) setProbing(false)
    }
  }

  async function testLlm() {
    llmAbort.current?.abort()
    const ac = new AbortController()
    llmAbort.current = ac
    setTestingLlm(true)
    setLlmResult(null)
    try {
      const provider = registry.getLLMProvider(draft)
      if (!provider) {
        setLlmResult({ ok: false, text: 'Pick a preset and give it a base URL first.' })
        return
      }
      // Small, but not TOO small. At maxTokens 8 every reasoning model failed
      // this test while being perfectly reachable: gpt-oss-120b on Cerebras
      // spends the whole budget in `reasoning` and returns content:null with
      // finish_reason "length". The test then reported a broken endpoint for
      // the exact class of model these fast providers are best at serving.
      const reply = await provider.complete({
        messages: [{ role: 'user', content: 'Reply with the single word: ok' }],
        maxTokens: 512,
        temperature: 0,
        signal: ac.signal,
      })
      const text = reply.trim()
      setLlmResult({ ok: true, text: text ? `it answered "${text.slice(0, 80)}"` : 'connected, but the reply was empty' })
    } catch (e) {
      if (isAbort(e)) return
      setLlmResult({ ok: false, text: errText(e) })
    } finally {
      if (!ac.signal.aborted) setTestingLlm(false)
    }
  }

  async function loadModels() {
    llmAbort.current?.abort()
    const ac = new AbortController()
    llmAbort.current = ac
    setLoadingModels(true)
    setLlmResult(null)
    try {
      const provider = registry.getLLMProvider(draft)
      if (!provider?.listModels) {
        setLlmResult({ ok: false, text: 'This endpoint does not publish a model list — type the id yourself.' })
        return
      }
      const list = await provider.listModels(ac.signal)
      setModels(list)
      if (list.length === 0) setLlmResult({ ok: false, text: 'The endpoint returned an empty model list.' })
    } catch (e) {
      if (isAbort(e)) return
      setLlmResult({ ok: false, text: errText(e) })
    } finally {
      if (!ac.signal.aborted) setLoadingModels(false)
    }
  }

  function save() {
    onSave({
      world: {
        active: world.active,
        reactor: { apiKey: world.reactor.apiKey.trim(), mode: world.reactor.mode },
        websocket: { url: world.websocket.url.trim(), apiKey: world.websocket.apiKey.trim(), protocol: world.websocket.protocol },
        alakazam: {
          apiBase: trimBase(world.alakazam.apiBase),
          embedHost: trimBase(world.alakazam.embedHost),
          apiKey: world.alakazam.apiKey.trim(),
        },
      },
      llm: {
        active: activeLlm,
        endpoints: activeLlm
          ? { ...draft.llm.endpoints, [activeLlm]: { baseUrl: trimBase(endpoint.baseUrl), apiKey: endpoint.apiKey.trim(), model: endpoint.model.trim() } }
          : draft.llm.endpoints,
      },
      image: { geminiKey: draft.image.geminiKey.trim(), model: draft.image.model.trim() },
      vision: {
        endpoint: draft.vision.endpoint,
        apiKey: draft.vision.apiKey.trim(),
        localUrl: draft.vision.localUrl.trim(),
      },
    })
  }

  // Browsers refuse ws:// from an https: page as mixed content, and the failure
  // arrives as an unexplained socket close, so say it before they hit it.
  const wsUrl = world.websocket.url.trim()
  const insecureWs = location.protocol === 'https:' && /^ws:\/\//i.test(wsUrl)
  const oddWsUrl = wsUrl.length > 0 && !/^wss?:\/\//i.test(wsUrl)
  const oddAlakazamKey = world.alakazam.apiKey.length > 0 && !KEY_SHAPE.test(world.alakazam.apiKey)
  // Unknown ids are assumed to want a key, matching what getLLMProvider() assumes —
  // otherwise the panel calls a key optional while isConfigured() quietly demands one.
  const needsKey = preset?.keyRequired ?? true
  const suggestions = models ?? (preset?.defaultModel ? [preset.defaultModel] : [])
  const llmBusy = testingLlm || loadingModels

  return (
    <div
      className="card"
      // maxHeight was '100%' against a parent (the scrim's unstyled centring
      // wrapper) that never has an explicit height of its own — a percentage
      // max-height resolves to "none" against an auto-height containing
      // block, so this never actually clamped anything and the panel ran
      // past the viewport with nothing to signal there was more below it.
      // A viewport-relative height does resolve, and turns overflowY:auto
      // into a real, visible scrollbar on the dialog itself.
      style={{ maxWidth: 720, width: '100%', maxHeight: 'calc(100vh - 48px)', overflowY: 'auto' }}
    >
      {/* Centred, caps, white — the same "hero title" scale every big header
          in the app now uses (h2 is uppercase globally), not a smaller
          green-tinted one-off. Green is reserved for the selected-provider
          state below, not spent on the title of the whole panel. */}
      <h2 style={{ textAlign: 'center' }}>Providers</h2>
      <p className="muted" style={{ marginTop: 0 }}>
        Two independent choices: what draws your world, and what writes it. Mix them however you like —
        neither one knows about the other, and the studio runs with neither.
      </p>

      <div className="diag info" style={{ margin: '0 0 18px', padding: '10px 12px', fontSize: 12.5, lineHeight: 1.55 }}>
        <strong>Where your keys go.</strong> Into this browser's <code>localStorage</code>, and nowhere else.
        Each one is sent only to the provider you picked below — your Reactor key to Reactor, your Groq key
        to Groq. Nothing is relayed through Alakazam, and nothing goes in a <code>.env</code> file: a key in
        a <code>VITE_</code> variable is compiled into the JavaScript everyone downloads, which publishes it
        rather than configures it. Clearing site data deletes these. Any script on this page can read them,
        so treat this as a studio you run for yourself, not one you host for strangers.
      </div>

      {/* ── World model ──────────────────────────────────────────────────── */}
      <section aria-labelledby="ps-world-h" style={{ borderTop: '1px solid var(--line)', paddingTop: 16 }}>
        <h3 id="ps-world-h">World model</h3>
        <p className="muted" style={{ marginTop: 0, fontSize: 12.5 }}>
          The thing that renders frames and reacts to your state machine.
        </p>

        <fieldset style={{ border: 0, padding: 0, margin: '10px 0 0', minWidth: 0 }}>
          <legend style={{ fontSize: 12, color: 'var(--dim)', padding: 0, marginBottom: 6 }}>Provider</legend>
          <div style={{ display: 'grid', gap: 6 }}>
            {registry.worldProviders.map((o) => {
              const on = world.active === o.id
              return (
                <label
                  key={o.id}
                  htmlFor={`ps-world-${o.id}`}
                  style={{
                    display: 'flex',
                    gap: 10,
                    alignItems: 'flex-start',
                    margin: 0,
                    padding: '9px 11px',
                    borderRadius: 6,
                    cursor: 'pointer',
                    color: 'var(--ink)',
                    background: on ? 'var(--ok-soft)' : 'transparent',
                    border: `1px solid ${on ? 'var(--ok-line)' : 'var(--line)'}`,
                  }}
                >
                  <input
                    id={`ps-world-${o.id}`}
                    type="radio"
                    name="ps-world"
                    value={o.id}
                    checked={on}
                    onChange={() => patchWorld({ active: o.id })}
                    // No width override needed: input[type="radio"] in the theme
                    // stylesheet now sizes and draws this control itself.
                    style={{ marginTop: 3, flex: 'none' }}
                  />
                  <span>
                    {/* Explicit size: the global `label` rule is 12px, which is caption-sized for a title. */}
                    <span style={{ fontSize: 13, fontWeight: 600, color: on ? 'var(--acc)' : 'var(--ink)' }}>{o.label}</span>
                    <span className="muted" style={{ display: 'block', fontSize: 12, marginTop: 2 }}>{o.blurb}</span>
                  </span>
                </label>
              )
            })}
          </div>
        </fieldset>

        {world.active === 'mock' && (
          <p className="muted" style={{ fontSize: 12.5, marginTop: 12, marginBottom: 0 }}>
            Nothing to configure. The mock draws placeholder frames locally, so the editor, the graph and the
            lint pass all work offline — it just cannot show you a world reacting.
          </p>
        )}

        {world.active === 'reactor' && (
          <>
            <SecretField
              id="ps-reactor-key"
              label="Reactor API key"
              value={world.reactor.apiKey}
              onChange={(v) => patchWorld({ reactor: { ...world.reactor, apiKey: v } })}
              placeholder="paste your Reactor key"
              destination="Reactor's own API"
              hint="Copy it from your Reactor dashboard."
            />
            <Field
              id="ps-reactor-mode"
              label="Session mode"
              hint={
                <>
                  What each mode accepts varies by account and by model, so do not take either on faith: switch,
                  press Test connection, and believe the capability row. If <code>World events</code> comes back
                  unsupported, your authored beats will not reach the picture.
                </>
              }
            >
              <Select
                id="ps-reactor-mode"
                value={world.reactor.mode}
                onChange={(e) => patchWorld({ reactor: { ...world.reactor, mode: e.target.value as 'adventure' | 'directing' } })}
              >
                <option value="adventure">adventure</option>
                <option value="directing">directing</option>
              </Select>
            </Field>
          </>
        )}

        {world.active === 'websocket' && (
          <>
            <Field
              id="ps-ws-url"
              label="WebSocket URL"
              hint={
                <>
                  Any address serving a world model over the studio's protocol. A local runtime is usually{' '}
                  <code>ws://localhost:PORT</code>.
                </>
              }
            >
              <TextInput
                id="ps-ws-url"
                value={world.websocket.url}
                onChange={(e) => patchWorld({ websocket: { ...world.websocket, url: e.target.value } })}
                placeholder="wss://your-box.example.com/stream"
              />
            </Field>
            {oddWsUrl && (
              <div className="diag warning" style={{ marginTop: 8 }}>
                That is not a WebSocket URL. It has to start with <code>ws://</code> or <code>wss://</code> —{' '}
                <code>http://</code> will not upgrade.
              </div>
            )}
            {insecureWs && (
              <div className="diag error" style={{ marginTop: 8 }}>
                This page is served over HTTPS, and browsers block plain <code>ws://</code> from an HTTPS page
                as mixed content — you will see the socket close with no explanation. Use <code>wss://</code>,
                or run the studio from <code>http://localhost</code>.
              </div>
            )}

            <SecretField
              id="ps-ws-key"
              label="API key (optional)"
              value={world.websocket.apiKey}
              onChange={(v) => patchWorld({ websocket: { ...world.websocket, apiKey: v } })}
              placeholder="only if your endpoint asks for one"
              destination={hostOf(world.websocket.url, 'the address above')}
              hint="Handed over during the handshake. Leave it blank for an open local runtime."
            />

            <Field
              id="ps-ws-protocol"
              label="Protocol"
              hint={
                <>
                  Start on <code>auto</code>. <code>raw</code> has no channel for authored events, so expect the
                  warning below and a world that ignores your transitions.
                </>
              }
            >
              <Select
                id="ps-ws-protocol"
                value={world.websocket.protocol}
                onChange={(e) => patchWorld({ websocket: { ...world.websocket, protocol: e.target.value as 'auto' | 'alakazam-ws' | 'raw' } })}
              >
                <option value="auto">auto — negotiate, then fall back</option>
                <option value="alakazam-ws">alakazam-ws — the runtime's own protocol</option>
                <option value="raw">raw — frames out, no event channel</option>
              </Select>
            </Field>
          </>
        )}

        {world.active === 'alakazam' && (
          <>
            <Field id="ps-ak-base" label="API base">
              <TextInput
                id="ps-ak-base"
                value={world.alakazam.apiBase}
                onChange={(e) => patchWorld({ alakazam: { ...world.alakazam, apiBase: e.target.value } })}
                placeholder="https://api.alakazam.gg"
              />
            </Field>
            <Field id="ps-ak-embed" label={<>Embed host <span className="muted">(the runtime iframe)</span></>}>
              <TextInput
                id="ps-ak-embed"
                value={world.alakazam.embedHost}
                onChange={(e) => patchWorld({ alakazam: { ...world.alakazam, embedHost: e.target.value } })}
                placeholder="https://play.alakazam.gg"
              />
            </Field>
            <SecretField
              id="ps-ak-key"
              label="Secret API key"
              value={world.alakazam.apiKey}
              onChange={(v) => patchWorld({ alakazam: { ...world.alakazam, apiKey: v } })}
              placeholder="sk_live_… or sk_test_…"
              destination={hostOf(world.alakazam.apiBase, 'the API base above')}
              hint={<>Needs <code>worlds:read/write</code> and <code>sessions:mint</code>. From your dashboard.</>}
            />
            {oddAlakazamKey && (
              <div className="diag warning" style={{ marginTop: 8 }}>
                Alakazam keys normally start <code>sk_test_</code>, <code>sk_live_</code>, <code>pk_test_</code>{' '}
                or <code>pk_live_</code>. Save it anyway if you are pointing at your own deployment.
              </div>
            )}
          </>
        )}

        <div className="row" style={{ marginTop: 16, flexWrap: 'wrap' }}>
          <Button variant="ghost" busy={probing} onClick={() => void testWorld()} disabled={!worldReady(world)}>
            {probing ? 'Testing…' : 'Test connection'}
          </Button>
          {!worldReady(world) && <span className="muted" style={{ fontSize: 12 }}>fill in the fields above to enable</span>}
        </div>

        {/* No aria-live here on purpose: CapabilityBadge announces itself (role=status
            while probing, role=alert for the warning), and wrapping it in a second
            live region makes screen readers read the result twice. */}
        <div style={{ marginTop: 10 }}>
          {probing ? (
            <CapabilityBadge capabilities={caps ?? NO_CAPABILITIES} probing />
          ) : caps ? (
            <>
              {probeErr && <div className="diag error" role="alert" style={{ marginBottom: 8 }}>{probeErr}</div>}
              <CapabilityBadge capabilities={caps} />
            </>
          ) : (
            <p className="muted" style={{ fontSize: 12, margin: 0 }}>
              Not probed yet. Capabilities are asked for, never assumed — test the connection and the backend
              will tell you what it can actually do.
            </p>
          )}
        </div>
      </section>

      {/* ── LLM ──────────────────────────────────────────────────────────── */}
      <section aria-labelledby="ps-llm-h" style={{ borderTop: '1px solid var(--line)', marginTop: 22, paddingTop: 16 }}>
        <h3 id="ps-llm-h">Language model</h3>
        <p className="muted" style={{ marginTop: 0, fontSize: 12.5 }}>
          Writes and edits worlds. Anything that answers OpenAI's <code>/chat/completions</code> works, which
          is nearly everything — a hosted vendor, or a server on your own machine.
        </p>

        <Field id="ps-llm-preset" label="Preset">
          <Select id="ps-llm-preset" value={activeLlm} onChange={(e) => selectPreset(e.target.value)}>
            <option value="">— none: the studio runs, the agent panel stays off —</option>
            {LLM_PRESETS.map((p) => (
              <option key={p.id} value={p.id}>{p.label}</option>
            ))}
            {/* A saved id that no longer matches a preset must still round-trip. */}
            {activeLlm && !preset && <option value={activeLlm}>{activeLlm}</option>}
          </Select>
        </Field>
        {preset?.note && <div className="muted" style={{ fontSize: 12, marginTop: 4 }}>{preset.note}</div>}

        {!activeLlm ? (
          <p className="muted" style={{ fontSize: 12.5, marginTop: 12, marginBottom: 0 }}>
            No model selected. Everything except the writing agent still works — you can build, edit and play
            a world by hand. Pick a preset above to turn the agent on.
          </p>
        ) : (
          <>
            <Field
              id="ps-llm-base"
              label="Base URL"
              hint={
                <>
                  The root that <code>/chat/completions</code> is appended to. Presets fill this in; override it
                  for a proxy or a local server.
                </>
              }
            >
              <TextInput
                id="ps-llm-base"
                value={endpoint.baseUrl}
                onChange={(e) => patchEndpoint({ baseUrl: e.target.value })}
                placeholder="https://api.example.com/v1"
              />
            </Field>
            {preset?.corsHint && (
              // Said up front, because the browser's version of this is an opaque red
              // console line that looks like the key is wrong when it is not.
              <div className="diag info" style={{ marginTop: 8 }}>
                <strong>Reachable from a browser?</strong> {preset.corsHint}
              </div>
            )}

            <SecretField
              id="ps-llm-key"
              label={needsKey ? 'API key' : 'API key (optional)'}
              value={endpoint.apiKey}
              onChange={(v) => patchEndpoint({ apiKey: v })}
              placeholder={needsKey ? 'paste your key' : 'usually blank for a local server'}
              destination={hostOf(endpoint.baseUrl, 'the base URL above')}
              hint={
                <>
                  Stored against <strong>{preset?.label ?? activeLlm}</strong> alone — switching preset does not
                  carry it over, and switching back brings it back.
                  {preset?.docsUrl && (
                    <>
                      {' '}
                      <a href={preset.docsUrl} target="_blank" rel="noreferrer" style={{ color: 'var(--acc2)' }}>
                        {preset.local ? `Install ${preset.label} ↗` : `Get a ${preset.label} key ↗`}
                      </a>
                    </>
                  )}
                </>
              }
            />
            {needsKey && !endpoint.apiKey.trim() && (
              <div className="diag warning" style={{ marginTop: 8 }}>
                {preset?.label ?? 'This provider'} requires a key. You can still test — the endpoint's own 401
                is the honest answer.
              </div>
            )}

            <Field
              id="ps-llm-model"
              label="Model"
              hint={
                models
                  ? `${models.length} model${models.length === 1 ? '' : 's'} reported by the endpoint — any of them, or type your own.`
                  : 'A first guess from the preset. Load the list to see what this endpoint actually serves.'
              }
            >
              <TextInput
                id="ps-llm-model"
                value={endpoint.model}
                onChange={(e) => patchEndpoint({ model: e.target.value })}
                placeholder="model id"
                list={suggestions.length ? 'ps-llm-models' : undefined}
              />
            </Field>
            {suggestions.length > 0 && (
              <datalist id="ps-llm-models">
                {suggestions.map((m) => <option key={m} value={m} />)}
              </datalist>
            )}

            <div className="row" style={{ marginTop: 16, flexWrap: 'wrap' }}>
              <Button variant="ghost" busy={testingLlm} onClick={() => void testLlm()} disabled={llmBusy || !endpoint.baseUrl.trim()}>
                {testingLlm ? 'Testing…' : 'Test'}
              </Button>
              <Button variant="ghost" busy={loadingModels} onClick={() => void loadModels()} disabled={llmBusy || !endpoint.baseUrl.trim()}>
                {loadingModels ? 'Loading…' : 'Load models'}
              </Button>
              <span className="muted" style={{ fontSize: 12 }}>
                {endpoint.baseUrl.trim() ? 'Test sends one tiny prompt, nothing else' : 'add a base URL to enable'}
              </span>
            </div>

            <div aria-live="polite">
              {llmResult && (
                <div className={llmResult.ok ? 'diag info' : 'diag error'} style={{ marginTop: 10 }}>
                  <strong style={{ color: llmResult.ok ? 'var(--acc)' : 'var(--err)' }}>
                    <span aria-hidden="true">{llmResult.ok ? '✓ ' : '✕ '}</span>
                    {llmResult.ok ? 'Reached it' : 'Failed'}
                  </strong>{' '}
                  — {llmResult.text}
                </div>
              )}
            </div>
          </>
        )}
      </section>

      {/* ── Seed images ──────────────────────────────────────────────────── */}
      <section aria-labelledby="ps-image-h" style={{ borderTop: '1px solid var(--line)', marginTop: 22, paddingTop: 16 }}>
        <h3 id="ps-image-h">Seed images</h3>
        <p className="muted" style={{ marginTop: 0, fontSize: 12.5 }}>
          Powers "Paint a seed frame" in Create. The image it returns becomes the world's first frame — the
          anchor that image-seeded world models like <code>lingbot-world-2</code> start generating from. Your
          key is kept in this browser's <code>localStorage</code> and sent only to Google. Without it, painting
          falls back to the hosted path when an Alakazam key is configured above, or is turned off entirely.
        </p>

        <SecretField
          id="ps-gemini-key"
          label="Gemini API key"
          value={draft.image.geminiKey}
          onChange={(v) => patchImage({ geminiKey: v })}
          placeholder="paste your Gemini API key"
          destination="Google's generativelanguage API"
          hint="From Google AI Studio."
        />
        <Field
          id="set-gemini-model"
          label="Model"
          hint="Nano Banana Pro by default. Any Gemini image model id works."
        >
          <TextInput
            id="set-gemini-model"
            value={draft.image.model}
            onChange={(e) => patchImage({ model: e.target.value })}
            placeholder="gemini-3-pro-image"
          />
        </Field>
      </section>

      {/* ── Vision ───────────────────────────────────────────────────────── */}
      <section aria-labelledby="ps-vision-h" style={{ borderTop: '1px solid var(--line)', marginTop: 22, paddingTop: 16 }}>
        <h3 id="ps-vision-h">Vision</h3>
        <p className="muted" style={{ marginTop: 0, fontSize: 12.5 }}>
          Grounds a world's clickable objects in what a detector can actually see, instead of trusting an
          author's guess that "the lantern" sits where the prose says it does. Cloud sends the frame to
          Moondream's hosted API with your key; local runs the same open-vocabulary detector on your own
          machine, so this axis works with no key and no account at all.
        </p>

        <Field id="ps-vision-endpoint" label="Endpoint">
          <Select
            id="ps-vision-endpoint"
            value={draft.vision.endpoint}
            onChange={(e) => patchVision({ endpoint: e.target.value === 'cloud' ? 'cloud' : 'local' })}
          >
            <option value="local">local — Moondream Station (self-hosted, no key)</option>
            <option value="cloud">cloud — Moondream Cloud (your key)</option>
          </Select>
        </Field>

        <SecretField
          id="ps-moondream-key"
          label="Moondream Cloud API key"
          value={draft.vision.apiKey}
          onChange={(v) => patchVision({ apiKey: v })}
          placeholder="paste your Moondream key"
          destination="Moondream's api.moondream.ai"
          hint="Only read when Endpoint above is cloud. From your moondream.ai dashboard."
        />

        <Field
          id="set-moondream-url"
          label="Local URL"
          hint="Only read when Endpoint above is local. Moondream Station's default port is 2020."
        >
          <TextInput
            id="set-moondream-url"
            value={draft.vision.localUrl}
            onChange={(e) => patchVision({ localUrl: e.target.value })}
            placeholder="http://localhost:2020/v1/detect"
          />
        </Field>
      </section>

      <div className="row" style={{ marginTop: 22, paddingTop: 16, borderTop: '1px solid var(--line)', flexWrap: 'wrap' }}>
        <Button variant="primary" text="Save providers" onClick={save} />
        {onClose && <Button variant="ghost" text="Close" onClick={onClose} />}
        <span className="spacer" />
        {/* Anything that asks for API keys owes the user a way to take them back.
            Two-step because it is destructive and there is no undo — the keys
            live only here, so a stray click would mean re-fetching them from
            four different vendor dashboards. */}
        {confirmingReset ? (
          <>
            <span className="muted" style={{ fontSize: 12 }}>Erase every provider setting and key?</span>
            <Button variant="ghost" text="Cancel" onClick={() => setConfirmingReset(false)} />
            <Button
              variant="ghost"
              text="Erase"
              style={{ color: 'var(--err)' }}
              // The draft has to be replaced too, not just storage and the parent:
              // leaving the old values in the fields would show keys that no longer
              // exist, and the next "Save providers" would write them straight back.
              onClick={() => {
                const cleared = registry.resetProviderConfig()
                setConfirmingReset(false)
                setDraft(cleared)
                setCaps(null)
                setProbeErr(null)
                setLlmResult(null)
                setModels(null)
                onSave(cleared)
              }}
            />
          </>
        ) : (
          <Button variant="ghost" text="Clear keys…" onClick={() => setConfirmingReset(true)} />
        )}
      </div>
      <div className="muted" style={{ fontSize: 12, marginTop: 8 }}>
        Clearing wipes every key and endpoint from this browser and puts the studio back on the mock
        world model. Nothing is copied anywhere else, so there is nothing to undo it from.
      </div>
    </div>
  )
}

/**
 * A key input you can actually check for typos. Masked by default, because these
 * sit on screen while people screen-share; revealable, because a mistyped key you
 * cannot see costs far more than the glance it saves.
 *
 * `destination` is required rather than folded into the free-text hint, and the
 * sentence it produces is printed unconditionally. A text box asking a stranger
 * for an API key owes them an answer to "where does this go?", and the way to
 * make sure every such box carries that answer is to make the component refuse
 * to render without it — a hint you can forget is a hint that gets forgotten.
 */
function SecretField({
  id,
  label,
  value,
  onChange,
  placeholder,
  destination,
  hint,
}: {
  id: string
  label: string
  value: string
  onChange: (value: string) => void
  placeholder?: string
  /** Where this key travels, named as concretely as the settings allow. */
  destination: string
  hint?: ReactNode
}) {
  const [shown, setShown] = useState(false)
  return (
    <Field
      id={id}
      label={label}
      hint={
        <span style={{ lineHeight: 1.5 }}>
          Kept in this browser's <code>localStorage</code>. Sent to{' '}
          <strong style={{ color: 'var(--ink)', fontWeight: 600 }}>{destination}</strong> and nowhere else —
          this studio is a static page with no server of its own to relay it through.
          {hint && <> {hint}</>}
        </span>
      }
    >
      <div className="row">
        <TextInput
          id={id}
          type={shown ? 'text' : 'password'}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          placeholder={placeholder}
          style={{ minWidth: 0 }}
        />
        <Button
          variant="ghost"
          style={{ flex: 'none' }}
          aria-pressed={shown}
          aria-label={shown ? `Hide ${label}` : `Show ${label}`}
          onClick={() => setShown((s) => !s)}
          text={shown ? 'Hide' : 'Show'}
        />
      </div>
    </Field>
  )
}
