/**
 * Provider registry — construction, selection and persistence for both axes.
 *
 * One place decides which world model draws the picture and which LLM writes the
 * worlds, so the rest of the app never has to know how either was configured. It
 * is deliberately free of React: the UI subscribes to it, not the other way
 * round, which keeps providers constructible from tests and scripts.
 *
 * Everything the user sets lands in localStorage under a single versioned key.
 * NOTHING comes from a VITE_ variable except endpoint addresses, and that split
 * is not cosmetic: Vite inlines env values into the JavaScript bundle at build
 * time, so a key placed there is published to every visitor rather than
 * configured by one operator. Addresses are safe to publish; keys never are.
 */

import type {
  ImageProvider,
  LLMProvider,
  ProviderConfig,
  VisionProvider,
  WorldCapabilities,
  WorldModelProvider,
} from './types'
import { createReactorWorldProvider } from './world/reactor'
import { createWebSocketWorldProvider } from './world/websocket'
import { createAlakazamWorldProvider } from './world/alakazam'
import { createMockWorldProvider } from './world/mock'
import { createOpenAICompatProvider } from './llm/openaiCompat'
import { createGeminiImageProvider, DEFAULT_GEMINI_IMAGE_MODEL } from './image/gemini'
import { createMoondreamVisionProvider } from './vision/moondream'
import {
  CUSTOM_PRESET_ID,
  DEFAULT_LLM_PRESET_ID,
  LLM_PRESETS,
  getPreset,
  type LLMPreset,
} from './llm/presets'

/** Re-exported so a call site has one import for everything about providers.
 *  The table itself is owned by ./llm/presets — this is a door, not a copy. */
export { LLM_PRESETS, CUSTOM_PRESET_ID, DEFAULT_LLM_PRESET_ID }
export type { LLMPreset }

export type WorldProviderId = WorldModelProvider['id']
/** One configured OpenAI-compatible endpoint, as persisted. */
export type LLMEndpoint = ProviderConfig['llm']['endpoints'][string]

// ─── The warning ─────────────────────────────────────────────────────────────

/**
 * The single most consequential string in the studio.
 *
 * A backend that streams frames is not necessarily a backend that listens. Point
 * the studio at one that only streams and everything on this side keeps working
 * perfectly — states change, transitions fire, the HUD updates — while the video
 * plays on, indifferent. Nothing errors. Nothing is red. People lose an hour to
 * that before they suspect the backend, so we say it out loud, permanently, for
 * as long as the session is live.
 */
export function capabilityWarning(caps: WorldCapabilities): string | null {
  if (caps.promptableEvents && caps.streaming) return null
  if (caps.promptableEvents) {
    // Listens but draws nothing. This used to return null — the check was
    // `if (caps.promptableEvents) return null`, so a backend that took every
    // event and rendered no picture was the one broken configuration the studio
    // had nothing to say about. You would sit in front of a black panel with a
    // row of green ticks above it.
    return (
      'This backend accepts the events your world sends it but is not sending a picture back. ' +
      'Everything you author is getting through — states change, transitions fire — there is just ' +
      'nothing to see. That usually means the endpoint is a control channel rather than a world ' +
      'model, or its video side is down. Check the connection in Settings.'
    )
  }
  if (!caps.streaming) {
    return (
      'This backend is not sending a picture, and it will not accept the events your world sends it. ' +
      'The world itself still runs — states change and transitions fire on cue — but none of it will be ' +
      'visible. Check the connection details in Settings, or switch to a provider that both streams and ' +
      'accepts world events.'
    )
  }
  return (
    'This backend streams video but will not accept the events your world sends it. ' +
    'Your world still runs — states change, transitions fire, the HUD keeps up — and the picture ignores ' +
    'all of it: a door you open or an alarm you trigger will never appear on screen. Nothing you have ' +
    'authored is wrong, and nothing you build now is wasted. To actually see it, connect a backend that ' +
    'takes world events — your own Reactor key, or a WebSocket world model that advertises them.'
  )
}

// ─── Storage ─────────────────────────────────────────────────────────────────

/** Bumped when the persisted shape changes. A different namespace from the key
 *  below, so both can coexist and the old one stays readable. */
const LS_KEY = 'alakazam-studio:providers:v1'
/** app-config.ts's key: { apiBase, embedHost, apiKey } — the hosted path only. */
const LEGACY_KEY = 'alakazam-studio:config:v1'

/**
 * The two build-time settings this studio reads, named ONE AT A TIME.
 *
 * This used to capture the whole object — `const env = import.meta.env` — which
 * is a leak, not a style choice: Vite replaces that expression with an object
 * literal containing EVERY `VITE_` variable present at build time, so any
 * secret in the builder's environment shipped inside the bundle to every
 * visitor. CI caught it with a poisoned-environment build (fake keys in
 * `VITE_*`, then grep the output), which is the job that guard exists to do.
 *
 * Naming each variable means Vite inlines only these two, and the optional
 * chaining keeps the module importable under Node — where `import.meta.env`
 * does not exist at all — because the CLI imports this file too. The names are
 * declared in `src/vite-env.d.ts`; a DOTTED access is what Vite replaces
 * statically, so bracket access would quietly ship the default instead.
 */
const DEFAULT_API_BASE = trimUrl(import.meta.env?.VITE_ALAKAZAM_API_BASE || 'https://api.alakazam.gg')
const DEFAULT_EMBED_HOST = trimUrl(import.meta.env?.VITE_ALAKAZAM_EMBED_HOST || 'https://play.alakazam.gg')

function trimUrl(v: string): string {
  return v.trim().replace(/\/+$/, '')
}

function readRaw(key: string): string | null {
  try {
    return localStorage.getItem(key)
  } catch {
    return null // private mode / storage disabled — the studio still runs, unsaved
  }
}

function writeRaw(key: string, value: string): void {
  try {
    localStorage.setItem(key, value)
  } catch {
    /* storage disabled — this session only */
  }
}

// ─── Providers, described ────────────────────────────────────────────────────

export interface WorldProviderInfo {
  id: WorldProviderId
  label: string
  /** One line under the radio button, in the picker. */
  blurb: string
}

/**
 * The four, in picker order: the ones you own first, the hosted path next, the
 * one that needs nothing last. This array is the single source for how a world
 * provider is named and described — the picker, the empty states and Settings
 * all read it, so the copy is edited in one place.
 */
export const worldProviders: readonly WorldProviderInfo[] = [
  {
    id: 'reactor',
    label: 'Reactor (your key)',
    blurb: 'Your own Reactor key, straight to their API. Nothing is routed through anyone else.',
  },
  {
    id: 'websocket',
    label: 'WebSocket endpoint',
    blurb: 'Any WebSocket address serving a world model — your machine, your cluster. What it can do is probed on connect, not assumed.',
  },
  {
    id: 'alakazam',
    label: 'Alakazam (hosted)',
    blurb: 'The hosted path, unchanged: worlds, sessions and the player, with an account and an API key.',
  },
  {
    id: 'mock',
    label: 'Mock (no key, canned frames)',
    blurb: 'No key, no network, no account. The default, so the studio works before you have signed up for anything.',
  },
]

export const WORLD_PROVIDER_IDS: readonly WorldProviderId[] = worldProviders.map((p) => p.id)

// An object literal over the closed WorldProviderId union rather than
// Object.fromEntries + a cast: the compiler now rejects a missing or
// misspelled id here instead of trusting the array shape at runtime.

/** Alias: ./llm/presets owns the lookup, this is just the name at this import site. */
export const llmPreset: (id: string) => LLMPreset | undefined = getPreset

/**
 * Saved values, with the preset filling in whatever the user left blank.
 *
 * A preset's `defaultModel` is a first guess, never a whitelist: people run
 * fine-tunes and local checkpoints no preset will ever enumerate, so a saved
 * model is passed through untouched and the guess is used only when the user has
 * chosen nothing at all. The endpoint's own /models is the live truth.
 */
export function llmEndpoint(cfg: ProviderConfig, presetId: string): LLMEndpoint {
  const preset = llmPreset(presetId)
  const saved = cfg.llm.endpoints[presetId]
  return {
    baseUrl: trimUrl(saved?.baseUrl || preset?.baseUrl || ''),
    apiKey: saved?.apiKey ?? '',
    model: saved?.model || preset?.defaultModel || '',
  }
}

/**
 * Does this endpoint want a key? An id no preset claims came from hand-edited
 * storage or a newer build, and a remote that might demand auth is the safer
 * assumption there. One helper, read both by the check below and by the adapter
 * we construct, so the studio's idea of "set up" cannot drift from the
 * provider's own answer.
 */
function requiresKey(presetId: string): boolean {
  return llmPreset(presetId)?.keyRequired ?? true
}

/**
 * Is this endpoint set up enough to elect it as the active one? Past the saved
 * row required below, this is the same test OpenAICompatProvider.isConfigured()
 * applies — an address, a model, and a key where one is wanted — so the studio's
 * idea of "set up" cannot drift from the provider's own answer.
 *
 * The saved row is the load-bearing part. Every preset ships a working-looking
 * base URL and model, so electing on preset defaults alone would hand the agent
 * to a local runtime the user has never installed, and the studio would announce
 * itself ready and then fail on the first message. A row exists only once someone
 * has saved that endpoint in Settings, which is the closest thing to intent we
 * have without probing a port nobody asked us to probe.
 */
export function llmEndpointConfigured(cfg: ProviderConfig, presetId: string): boolean {
  if (!cfg.llm.endpoints[presetId]) return false
  const resolved = llmEndpoint(cfg, presetId)
  if (!resolved.baseUrl || !resolved.model) return false
  return requiresKey(presetId) ? !!resolved.apiKey.trim() : true
}

// ─── Config: defaults, parsing, migration ────────────────────────────────────

export function defaultProviderConfig(): ProviderConfig {
  return {
    world: {
      // Mock, so the studio is usable the second it loads — no account, no key,
      // no network. Every other provider is one Settings field away.
      active: 'mock',
      reactor: { apiKey: '', mode: 'adventure' },
      websocket: { url: '', apiKey: '', protocol: 'auto' },
      alakazam: { apiBase: DEFAULT_API_BASE, embedHost: DEFAULT_EMBED_HOST, apiKey: '' },
    },
    // No LLM until someone picks one. The temptation is to default to the keyless
    // local runtime so the agent works out of the box, but that is a claim about
    // the user's machine we have no evidence for: on the majority of machines it
    // would light up an agent panel that fails on the first message. The studio
    // is fully usable without an LLM — only the agent needs one — so it says so
    // instead. Settings still opens on DEFAULT_LLM_PRESET_ID, ready to save.
    //
    // Endpoints start empty for the same reason: a row here means "the user saved
    // this one", which is what elects it below. Blank fields fall back to the
    // preset's own defaults at read time, so nothing is lost by not seeding.
    llm: { active: '', endpoints: {} },
    // A default model, unlike llm's empty endpoints: there is exactly one
    // vendor on this axis, so there is no "which preset" question to defer.
    // Painting still stays off until a key is saved — isConfigured() gates it.
    image: { geminiKey: '', model: DEFAULT_GEMINI_IMAGE_MODEL },
    // Local is the default ENDPOINT (no account needed to try grounding at
    // all), but apiKey and localUrl both start blank like every other saved
    // credential/address in this file — a non-blank stored default would make
    // isConfigured() true before anyone touched Settings, which is exactly the
    // keyless promise this studio exists to keep. moondream.ts's
    // DEFAULT_MOONDREAM_LOCAL_URL is a suggestion shown as the field's
    // placeholder, never a value silently assumed on your behalf.
    vision: { endpoint: 'local', apiKey: '', localUrl: '' },
  }
}

const str = (v: unknown, fallback = ''): string => (typeof v === 'string' ? v : fallback)

function oneOf<T extends string>(v: unknown, allowed: readonly T[], fallback: T): T {
  return allowed.find((a) => a === v) ?? fallback
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

function asRecord(v: unknown): Record<string, unknown> {
  return isRecord(v) ? v : {}
}

function normalizeEndpoints(v: unknown): Record<string, LLMEndpoint> {
  // Only what was saved. Seeding the presets in here would make every endpoint
  // look like one the user had set up, which is exactly what election reads.
  const out: Record<string, LLMEndpoint> = {}
  for (const [id, raw] of Object.entries(asRecord(v))) {
    const e = asRecord(raw)
    out[id] = { baseUrl: trimUrl(str(e["baseUrl"])), apiKey: str(e["apiKey"]).trim(), model: str(e["model"]).trim() }
  }
  return out
}

/** Anything on disk is untrusted input: hand-edited, half-written, or older. */
function normalize(raw: unknown): ProviderConfig {
  const d = defaultProviderConfig()
  const top = asRecord(raw)
  const world = asRecord(top["world"])
  const reactor = asRecord(world["reactor"])
  const ws = asRecord(world["websocket"])
  const alakazam = asRecord(world["alakazam"])
  const llm = asRecord(top["llm"])
  const image = asRecord(top["image"])
  const vision = asRecord(top["vision"])

  const cfg: ProviderConfig = {
    world: {
      active: oneOf(world["active"], WORLD_PROVIDER_IDS, d.world.active),
      reactor: {
        apiKey: str(reactor["apiKey"]).trim(),
        mode: oneOf(reactor["mode"], ['adventure', 'directing'] as const, d.world.reactor.mode),
      },
      websocket: {
        url: str(ws["url"]).trim(),
        apiKey: str(ws["apiKey"]).trim(),
        protocol: oneOf(ws["protocol"], ['auto', 'alakazam-ws', 'raw'] as const, d.world.websocket.protocol),
      },
      alakazam: {
        apiBase: trimUrl(str(alakazam["apiBase"])) || d.world.alakazam.apiBase,
        embedHost: trimUrl(str(alakazam["embedHost"])) || d.world.alakazam.embedHost,
        apiKey: str(alakazam["apiKey"]).trim(),
      },
    },
    llm: { active: str(llm["active"]).trim(), endpoints: normalizeEndpoints(llm["endpoints"]) },
    image: {
      geminiKey: str(image["geminiKey"]).trim(),
      // Blank on disk falls back to the default, same as alakazam's apiBase —
      // a saved-but-empty field must not leave the provider pointed at nothing.
      model: str(image["model"]).trim() || d.image.model,
    },
    vision: {
      endpoint: oneOf(vision["endpoint"], ['cloud', 'local'] as const, d.vision.endpoint),
      apiKey: str(vision["apiKey"]).trim(),
      // Deliberately NOT defaulted to DEFAULT_MOONDREAM_LOCAL_URL here, unlike
      // image.model above — localUrl gates isConfigured() for the local
      // endpoint, so silently filling it in would make a fresh clone look
      // configured before anyone chose to point it anywhere.
      localUrl: str(vision["localUrl"]).trim(),
    },
  }

  cfg.llm.active = resolveActiveLLM(cfg)
  return cfg
}

/**
 * An explicit choice is respected even when half-finished, so a user who clears
 * a key to paste a new one does not get silently switched to another vendor.
 * With no choice on record, adopt the one endpoint they did fill in.
 */
function resolveActiveLLM(cfg: ProviderConfig): string {
  if (cfg.llm.active) return cfg.llm.active
  const known = LLM_PRESETS.map((p) => p.id)
  const ids = [...known, ...Object.keys(cfg.llm.endpoints).filter((id) => !known.includes(id))]
  return ids.find((id) => llmEndpointConfigured(cfg, id)) ?? ''
}

/**
 * Fold the pre-refactor config forward. Someone who pasted a working key into
 * the old Settings must find the studio exactly as they left it — same API,
 * same embed host, still playing — rather than demoted to the mock with their
 * key apparently gone.
 */
function migrateLegacy(): ProviderConfig | null {
  const raw = readRaw(LEGACY_KEY)
  if (!raw) return null
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return null
  }
  const old = asRecord(parsed)
  const cfg = defaultProviderConfig()
  cfg.world.alakazam = {
    apiBase: trimUrl(str(old["apiBase"])) || cfg.world.alakazam.apiBase,
    embedHost: trimUrl(str(old["embedHost"])) || cfg.world.alakazam.embedHost,
    apiKey: str(old["apiKey"]).trim(),
  }
  if (cfg.world.alakazam.apiKey) cfg.world.active = 'alakazam'
  return cfg
}

// ─── Config: the live value ──────────────────────────────────────────────────

let cached: ProviderConfig | null = null

/** Read from storage, migrating the old shape on the way. Cheap to call. */
export function loadProviderConfig(): ProviderConfig {
  const raw = readRaw(LS_KEY)
  if (raw) {
    try {
      return normalize(JSON.parse(raw))
    } catch {
      /* malformed — fall through to migration/defaults rather than dying */
    }
  }
  const migrated = migrateLegacy()
  if (migrated) {
    const cfg = normalize(migrated)
    // Persist the fold so it happens once. The pre-refactor key is left in place:
    // it costs a few bytes and means a downgrade still finds the user's key.
    writeRaw(LS_KEY, JSON.stringify(cfg))
    return cfg
  }
  // Normalized rather than returned raw, so that a first run and a saved run
  // agree about which LLM is elected. Everything leaving this module has been
  // through the same funnel.
  return normalize(defaultProviderConfig())
}

/**
 * The current config. Stable by reference between writes, so it can back
 * useSyncExternalStore directly. Treat it as read-only: mutating it in place
 * changes what other components see without telling them.
 */
export function getProviderConfig(): ProviderConfig {
  if (!cached) cached = loadProviderConfig()
  return cached
}

export function saveProviderConfig(cfg: ProviderConfig): ProviderConfig {
  const next = normalize(cfg)
  cached = next
  writeRaw(LS_KEY, JSON.stringify(next))
  emit()
  return next
}

/**
 * Back to a blank studio: mock world, no keys anywhere. The pre-refactor key goes
 * too — leave it and the next load folds the old settings straight back in, so
 * the reset would look like it did nothing.
 */
export function resetProviderConfig(): ProviderConfig {
  try {
    localStorage.removeItem(LS_KEY)
    localStorage.removeItem(LEGACY_KEY)
  } catch {
    /* storage disabled */
  }
  cached = normalize(defaultProviderConfig())
  emit()
  return cached
}

// ─── Selection helpers ───────────────────────────────────────────────────────

// ─── Subscription ────────────────────────────────────────────────────────────

type Listener = () => void
const listeners = new Set<Listener>()
let storageBound = false

// A second tab editing Settings is a config change like any other; without this
// the two tabs disagree about which backend they are talking to.
function onStorage(e: StorageEvent): void {
  if (e.key !== null && e.key !== LS_KEY) return
  cached = null
  emit()
}

function emit(): void {
  for (const fn of [...listeners]) fn()
}

/** Notified on every config change. Returns the unsubscribe. */
export function subscribe(fn: Listener): () => void {
  listeners.add(fn)
  if (!storageBound && typeof window !== 'undefined') {
    window.addEventListener('storage', onStorage)
    storageBound = true
  }
  return () => {
    listeners.delete(fn)
    if (listeners.size === 0 && storageBound && typeof window !== 'undefined') {
      window.removeEventListener('storage', onStorage)
      storageBound = false
    }
  }
}

/** Alias, because `subscribe` alone is ambiguous at an import site. */
// ─── Construction ────────────────────────────────────────────────────────────

// Providers hold sockets and sessions, so they are rebuilt only when the
// settings they were built from actually change — not on every render.
function worldSignature(w: ProviderConfig['world']): string {
  switch (w.active) {
    case 'reactor':
      return `reactor|${w.reactor.apiKey}|${w.reactor.mode}`
    case 'websocket':
      return `websocket|${w.websocket.url}|${w.websocket.apiKey}|${w.websocket.protocol}`
    case 'alakazam':
      return `alakazam|${w.alakazam.apiBase}|${w.alakazam.embedHost}|${w.alakazam.apiKey}`
    default:
      return 'mock'
  }
}

let worldCache: { key: string; provider: WorldModelProvider } | null = null

/**
 * Pure over `cfg`, and undefaulted on purpose. Settings probes a draft the user
 * has typed but not saved; a fallback to stored config would quietly build from
 * the previous key and report a result for a value already replaced, which is
 * exactly how a "Test connection" button ends up lying. Call sites that want the
 * live one pass getProviderConfig().
 */
export function getWorldProvider(cfg: ProviderConfig): WorldModelProvider {
  const key = worldSignature(cfg.world)
  if (worldCache && worldCache.key === key) return worldCache.provider
  const provider = buildWorldProvider(cfg)
  worldCache = { key, provider }
  return provider
}

function buildWorldProvider(cfg: ProviderConfig): WorldModelProvider {
  switch (cfg.world.active) {
    case 'reactor':
      return createReactorWorldProvider(cfg.world.reactor)
    case 'websocket':
      return createWebSocketWorldProvider(cfg.world.websocket)
    case 'alakazam':
      return createAlakazamWorldProvider(cfg.world.alakazam)
    default:
      // Also the fallback for an id from a newer version of the studio: an
      // unreadable setting must not leave someone with no world at all.
      return createMockWorldProvider()
  }
}

let llmCache: { key: string; provider: LLMProvider } | null = null

/**
 * Never null. An unconfigured studio still gets an adapter — one whose
 * isConfigured() is false — so no call site has to null-check before asking the
 * only question that matters, which is whether the agent can run yet.
 *
 * Pure over `cfg`, and undefaulted, for the same reason as getWorldProvider.
 */
export function getLLMProvider(cfg: ProviderConfig): LLMProvider {
  // With no choice made, `custom` is the honest home for it: an empty endpoint
  // waiting to be filled in, rather than a vendor the user never picked.
  const id = cfg.llm.active || CUSTOM_PRESET_ID
  const ep = llmEndpoint(cfg, id)
  const key = `${id}|${ep.baseUrl}|${ep.apiKey}|${ep.model}`
  if (llmCache && llmCache.key === key) return llmCache.provider
  const provider = createOpenAICompatProvider({
    id,
    label: llmPreset(id)?.label ?? id,
    baseUrl: ep.baseUrl,
    apiKey: ep.apiKey,
    model: ep.model,
    // Passed through so isConfigured() does not demand a key from a server that
    // ignores auth, and so it answers exactly what llmEndpointConfigured() did.
    keyRequired: requiresKey(id),
  })
  llmCache = { key, provider }
  return provider
}

let imageCache: { key: string; provider: ImageProvider } | null = null

/**
 * Never null, mirroring getLLMProvider — an unconfigured studio still gets an
 * adapter whose isConfigured() is false, so no call site has to null-check
 * before asking whether painting a seed frame is possible yet.
 *
 * Pure over `cfg`, and undefaulted, for the same reason as getWorldProvider.
 */
export function getImageProvider(cfg: ProviderConfig): ImageProvider {
  const key = `${cfg.image.geminiKey}|${cfg.image.model}`
  if (imageCache && imageCache.key === key) return imageCache.provider
  const provider = createGeminiImageProvider({ apiKey: cfg.image.geminiKey, model: cfg.image.model })
  imageCache = { key, provider }
  return provider
}

let visionCache: { key: string; provider: VisionProvider } | null = null

/**
 * Never null, mirroring getImageProvider — an unconfigured studio still gets
 * an adapter whose isConfigured() is false, so no call site has to null-check
 * before asking whether grounding a detect query is possible yet.
 *
 * Pure over `cfg`, and undefaulted, for the same reason as getWorldProvider.
 */
export function getVisionProvider(cfg: ProviderConfig): VisionProvider {
  const v = cfg.vision
  const key = `${v.endpoint}|${v.apiKey}|${v.localUrl}`
  if (visionCache && visionCache.key === key) return visionCache.provider
  const provider = createMoondreamVisionProvider({ endpoint: v.endpoint, apiKey: v.apiKey, localUrl: v.localUrl })
  visionCache = { key, provider }
  return provider
}

/**
 * Convenience façade for call sites that want one import and short names —
 * `registry.world(cfg)`, `registry.llm(cfg)`. Same functions, same caches, and
 * `import * as registry from './registry'` reads identically.
 */
export const registry = {
  config: getProviderConfig,
  defaultConfig: defaultProviderConfig,
  world: getWorldProvider,
  llm: getLLMProvider,
  image: getImageProvider,
  vision: getVisionProvider,
  capabilityWarning,
  worldProviders,
  subscribe,
}
