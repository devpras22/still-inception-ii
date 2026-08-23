/**
 * Reactor world provider — YOUR Reactor key, straight to reactor.inc.
 *
 * The hosted path put a vendor between the studio and the GPU: their server held
 * the Reactor key, minted the session token, and served the runtime. Here you hold
 * the key, so seeing your world move stops depending on an account you cannot
 * create. Get one at reactor.inc → Dashboard → API Keys; it looks like `rk_…`.
 *
 * WHERE THE KEY LIVES. Reactor's docs say to keep `rk_` keys on a server and hand
 * the browser only a short-lived token. That is right for a public product, where
 * the browser belongs to a stranger. This is the other case: the operator of this
 * studio is the person who owns the key and the machine it runs on. So the key sits
 * in this browser's localStorage and every mint happens here — which also means any
 * script on the page can read it. If you ever serve this studio to other people,
 * put your own mint endpoint in front and clear the key out of Settings.
 *
 * WHAT THIS FILE CAN AND CANNOT DO. Minting is plain HTTP and is implemented here.
 * (Verified 2026-07-30 against api.reactor.inc: the preflight allows the
 * `Reactor-Api-Key` header and both it and the POST answer
 * `access-control-allow-origin: *`, so the mint works from a page with no proxy in
 * the middle; a bad key comes back 401; a mint is free and starts no GPU.) The video arrives
 * over WebRTC whose signaling is not publicly documented — only
 * `@reactor-team/js-sdk` speaks it. That SDK IS a dependency now and `src/main.tsx`
 * registers it at boot, so streaming works with no extra step — but it is imported
 * DYNAMICALLY, so anyone who never selects Reactor does not download ~150 kB of
 * WebRTC and mp4box for a provider they are not using.
 *
 * The indirection stays because it is what makes the runtime swappable: delete the
 * registration in main.tsx and the provider still loads, reporting
 * `streaming: false` with a note explaining why rather than failing at play time.
 * Promising frames we cannot draw is the same silent lie the capability system
 * exists to prevent.
 */

import {
  NO_CAPABILITIES,
  WorldProviderError,
  type ProviderConfig,
  type WorldCapabilities,
  type WorldConnectOptions,
  type WorldEvent,
  type WorldModelProvider,
  type WorldSession,
} from '../types'

/** Reactor's public API host. Their own SDK defaults here; a local runtime is :8080. */
export const REACTOR_API_BASE = 'https://api.reactor.inc'

/**
 * The model this provider drives. ProviderConfig pins a key and a mode, not a model
 * — one knob fewer to get wrong — so the choice is made here: lingbot-world-2 is
 * Reactor's navigable world model (live prompt steering plus WASD), which is the
 * shape an authored state graph needs. Point elsewhere by registering a runtime
 * factory that ignores `modelName` and builds its own client.
 */
export const REACTOR_MODEL = 'lingbot-world-2'

/** A session token only has to survive the connect handshake. Short blast radius. */
const SESSION_TOKEN_TTL_SECONDS = 900
/** The probe wants proof the key works, not a session — mint the shortest token. */
const PROBE_TTL_SECONDS = 60
/** lingbot rejects prompts past 1000 chars with a command_error you would never see. */
const MAX_PROMPT_CHARS = 1000

const NO_RUNTIME_NOTE =
  'Key accepted, but no streaming runtime is registered, so this studio cannot draw ' +
  'Reactor frames. The default build registers one in src/main.tsx — if you removed ' +
  'that line or are embedding this provider elsewhere, call registerReactorRuntime() ' +
  'before playing. Otherwise use the websocket provider, or stay on mock.'

export type ReactorConfig = ProviderConfig['world']['reactor']

// ─── Token mint (plain HTTP, no SDK) ─────────────────────────────────────────

export interface ReactorToken {
  jwt: string
  /** Unix seconds. Reactor clamps the TTL server-side, so believe this over your ask. */
  expiresAt: number | null
}

/**
 * Exchange an `rk_` key for a short-lived JWT (`POST /tokens`). Exported because
 * every path that opens a Reactor connection needs the same three lines — a
 * WebSocket endpoint fronting Reactor mints exactly this way, with `baseUrl`
 * pointed at itself.
 *
 * Throws WorldProviderError with a message meant for a human and, where there was
 * one, the HTTP status.
 */
export async function mintReactorToken(opts: {
  apiKey: string
  ttlSeconds?: number
  baseUrl?: string
  signal?: AbortSignal | undefined
}): Promise<ReactorToken> {
  const key = opts.apiKey.trim()
  if (!key) throw new WorldProviderError('no Reactor API key — add one in Settings → World model → Reactor')
  const base = (opts.baseUrl ?? REACTOR_API_BASE).replace(/\/+$/, '')
  // 6h is Reactor's ceiling and it clamps silently. Clamp the floor too, so a caller
  // asking for five seconds does not get a token that dies inside the handshake.
  const ttl = Math.min(Math.max(Math.round(opts.ttlSeconds ?? SESSION_TOKEN_TTL_SECONDS), 60), 21600)

  let res: Response
  try {
    res = await fetch(`${base}/tokens`, {
      method: 'POST',
      headers: { 'Reactor-API-Key': key, 'Content-Type': 'application/json' },
      body: JSON.stringify({ expires_after: ttl }),
      ...(opts.signal ? { signal: opts.signal } : {}),
    })
  } catch (e) {
    if (e instanceof Error && e.name === 'AbortError') throw new WorldProviderError('cancelled', 0)
    // fetch rejects identically for offline, DNS failure and a blocked cross-origin
    // request, and the browser withholds which one it was. Name all three.
    throw new WorldProviderError(
      `could not reach ${base} — network, DNS, or the request was blocked (${errorText(e)})`,
      0,
    )
  }
  if (!res.ok) throw new WorldProviderError(mintFailureText(res.status), res.status)

  const data: unknown = await res.json().catch(() => ({}))
  const jwt = isRecord(data) && typeof data["jwt"] === 'string' ? data["jwt"] : undefined
  if (!jwt) throw new WorldProviderError('Reactor answered the mint without a token', res.status)
  const expiresAt = isRecord(data) && typeof data["expires_at"] === 'number' ? data["expires_at"] : null
  return { jwt, expiresAt }
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

function mintFailureText(status: number): string {
  if (status === 401 || status === 403) {
    return `key rejected (HTTP ${status}) — copy it again from reactor.inc → Dashboard → API Keys`
  }
  if (status === 402) return 'Reactor refused on billing (HTTP 402) — check credits on your account'
  if (status === 429) return 'Reactor is rate-limiting this key (HTTP 429) — wait a moment and retry'
  if (status >= 500) return `Reactor is unavailable (HTTP ${status})`
  return `token mint failed (HTTP ${status})`
}

// ─── Optional streaming runtime ──────────────────────────────────────────────

/**
 * The slice of `@reactor-team/js-sdk`'s `Reactor` class this provider actually
 * uses, declared structurally so the SDK stays an optional extra: nothing in this
 * repository imports it, and a small adapter (or a test fake) can stand in.
 */
export interface ReactorClientLike {
  connect(jwt?: string, options?: Record<string, unknown>): Promise<void>
  disconnect(recoverable?: boolean): Promise<void>
  sendCommand(command: string, data: Record<string, unknown>): Promise<void>
  /**
   * Events used here: `trackReceived`, `statusChanged`, `error`, `message`,
   * `runtimeMessage`.
   *
   * `any[]` rather than `never[]`: the real SDK types its handlers as `any[]`,
   * and `never[]` made this interface stricter than the thing it describes, so
   * the actual `Reactor` class would not satisfy it. An interface a real
   * implementation cannot implement is a wrong interface, not a safe one.
   */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  on(event: string, handler: (...args: any[]) => void): void
  /** Needed only when a world opens on a first-frame image. */
  uploadFile?(file: Blob, options?: { name?: string }): Promise<unknown>
}

/**
 * May return a promise: the studio registers a factory that dynamically imports
 * the SDK, so a user who never selects Reactor does not download ~150 kB of
 * WebRTC and mp4box for a provider they are not using.
 */
export type ReactorRuntimeFactory = (
  options: { modelName: string },
) => ReactorClientLike | Promise<ReactorClientLike>

let runtimeFactory: ReactorRuntimeFactory | null = null

/**
 * Teach the studio to stream. Install the SDK yourself, then, once at boot:
 *
 *   import { Reactor } from '@reactor-team/js-sdk'
 *   registerReactorRuntime((options) => new Reactor(options))
 *
 * Pass `null` to forget it again. Anything implementing ReactorClientLike works —
 * a build you loaded from a CDN in index.html, a fork, a fake in a test.
 */
export function registerReactorRuntime(factory: ReactorRuntimeFactory | null): void {
  runtimeFactory = factory
}

declare global {
  /** The plain-script-tag escape hatch: markup outside this module's control
   *  can hang a Reactor SDK factory or class here instead of importing one. */
  // eslint-disable-next-line no-var
  var __REACTOR_SDK__: unknown
}

/** Structurally: anything callable with `new` and one options arg. Shallow on
 *  purpose — see the comment at its one call site below. */
function isReactorCtor(v: unknown): v is new (options: { modelName: string }) => ReactorClientLike {
  return typeof v === 'function'
}

/**
 * The registered factory, or one published on `globalThis.__REACTOR_SDK__` (either
 * a factory or an object with a `Reactor` constructor) — the escape hatch for
 * wiring the SDK from a plain script tag without editing the studio's source.
 */
function resolveRuntime(): ReactorRuntimeFactory | null {
  if (runtimeFactory) return runtimeFactory
  const published = globalThis.__REACTOR_SDK__
  if (typeof published === 'function') {
    // globalThis.__REACTOR_SDK__ is populated by markup this module does not
    // control (a <script> tag loading the vendor SDK), so nothing here can
    // verify its call signature beyond "it is callable" — this is the one
    // assertion in this file that isn't provable from source, and it is the
    // documented survivor for src/provider/world/reactor.ts.
    return published as ReactorRuntimeFactory
  }
  const ctor = isRecord(published) ? published["Reactor"] : undefined
  if (isReactorCtor(ctor)) return (options) => new ctor(options)
  return null
}

// ─── Provider ────────────────────────────────────────────────────────────────

export class ReactorWorldProvider implements WorldModelProvider {
  readonly id = 'reactor' as const
  readonly label = 'Reactor'

  /** Takes the settings slice, or a getter so a Settings edit is picked up without
   *  rebuilding the provider. Callers that rebuild on every change can pass either. */
  constructor(private readonly config: ReactorConfig | (() => ReactorConfig)) {}

  private cfg(): ReactorConfig {
    return typeof this.config === 'function' ? this.config() : this.config
  }

  // Any non-empty key counts. Keys look like `rk_…`, but only the mint can say
  // whether one is real, and refusing on a prefix would lock out anyone whose
  // account predates or postdates that convention.
  isConfigured(): boolean {
    return this.cfg().apiKey.trim().length > 0
  }

  async probe(signal?: AbortSignal | undefined): Promise<WorldCapabilities> {
    try {
      const cfg = this.cfg()
      if (!cfg.apiKey.trim()) {
        return { ...NO_CAPABILITIES, note: 'no Reactor API key yet — paste one in Settings' }
      }
      // A mint is free and touches no GPU, so this proves the key works without
      // starting anything billable.
      await mintReactorToken({ apiKey: cfg.apiKey, ttlSeconds: PROBE_TTL_SECONDS, signal })
      if (!resolveRuntime()) return { ...NO_CAPABILITIES, note: NO_RUNTIME_NOTE }
      return liveCapabilities(cfg.mode)
    } catch (e) {
      return { ...NO_CAPABILITIES, note: `Reactor: ${errorText(e)}` }
    }
  }

  async connect(options: WorldConnectOptions): Promise<WorldSession> {
    const cfg = this.cfg()
    const runtime = resolveRuntime()
    if (!runtime) throw new WorldProviderError(NO_RUNTIME_NOTE)

    const token = await mintReactorToken({
      apiKey: cfg.apiKey,
      ttlSeconds: SESSION_TOKEN_TTL_SECONDS,
      ...(options.signal ? { signal: options.signal } : {}),
    })
    // await: the registered factory may dynamically import the SDK.
    const client = await runtime({ modelName: REACTOR_MODEL })
    return openSession(client, token.jwt, liveCapabilities(cfg.mode), options)
  }
}

/** Factory form, for call sites that would rather not write `new`. */
export function createReactorWorldProvider(config: ReactorConfig | (() => ReactorConfig)): WorldModelProvider {
  return new ReactorWorldProvider(config)
}

function liveCapabilities(mode: ReactorConfig['mode']): WorldCapabilities {
  return {
    streaming: true,
    promptableEvents: true,
    // `heldCommands` is about the PLAYER driving. Directing mode hands the wheel to
    // the graph, so the studio should not offer WASD — authored command beats still
    // reach the model, they just arrive from the state machine instead of a key.
    heldCommands: mode === 'adventure',
    // A Reactor session is a GPU session, not a stored world: its state dies with
    // the session. The graph is persisted by this studio, never by Reactor.
    persistentWorlds: false,
    note:
      mode === 'adventure'
        ? `${REACTOR_MODEL} · the player drives; authored events layer on top`
        : `${REACTOR_MODEL} · directing: the graph drives, so no player WASD`,
  }
}

// ─── Session ─────────────────────────────────────────────────────────────────

async function openSession(
  client: ReactorClientLike,
  jwt: string,
  capabilities: WorldCapabilities,
  options: WorldConnectOptions,
): Promise<WorldSession> {
  const video = createVideoElement()
  const endedHandlers = new Set<(reason: string) => void>()
  let sawReady = false
  let disposed = false
  let seed: SeedReport = { prompt: false, image: false }
  /** Everything the model sent back, so a silent backend stops being silent. */
  const modelSaid: string[] = []
  /** Latched so the session ends ONCE and a late subscriber can still learn why. */
  let endedReason: string | null = null

  const fireEnded = (reason: string): void => {
    if (disposed || endedReason !== null) return
    endedReason = reason
    for (const handler of Array.from(endedHandlers)) {
      // One bad listener must not swallow the notification for the rest — this
      // used to throw straight out of fireEnded and skip every handler after it.
      try {
        handler(reason)
      } catch (e) {
        console.warn('[reactor] onEnded listener threw:', e)
      }
    }
    endedHandlers.clear()
  }

  // Wire the listeners BEFORE connecting: the first track can land during the
  // handshake, and a picture that arrived before anyone was listening never shows.
  client.on('trackReceived', (_name: string, _track: unknown, stream: MediaStream) => {
    // A model may publish several tracks; only one of them is the picture.
    if (stream.getVideoTracks().length > 0) video.srcObject = stream
  })
  client.on('statusChanged', (status: string) => {
    if (status === 'ready') sawReady = true
    else if (status === 'disconnected' && sawReady) fireEnded('Reactor closed the session')
  })
  client.on('error', (err: unknown) => fireEnded(errorText(err)))

  // Listen for what the MODEL says back.
  //
  // This file twice described a `command_error` "you would never see", and that
  // was literally true: the SDK delivers model-side replies on `message` and
  // `runtimeMessage`, and nothing here subscribed to either. So a rejected
  // prompt, a refused `start`, or a moderation stop arrived, was dropped on the
  // floor, and presented to the user as a session that is ready, connected, and
  // black. Anything the model calls an error now ends the session with the
  // model's own words, and everything else is recorded for the note.
  const observeMessage = (payload: unknown): void => {
    if (!isRecord(payload)) return
    const type = typeof payload["type"] === 'string' ? payload["type"] : ''
    const detail =
      (typeof payload["error"] === 'string' && payload["error"]) ||
      (typeof payload["message"] === 'string' && payload["message"]) ||
      ''
    if (/error|reject|denied|terminate/i.test(type) || detail) {
      modelSaid.push(detail ? `${type || 'error'}: ${detail}` : type)
      if (/error|terminate/i.test(type)) fireEnded(detail || type)
    } else if (type) {
      modelSaid.push(type)
    }
  }
  client.on('message', observeMessage)
  client.on('runtimeMessage', observeMessage)

  try {
    await client.connect(jwt, {})
    throwIfAborted(options.signal)
    seed = await seedWorld(client, options)
    throwIfAborted(options.signal)
  } catch (e) {
    // Reactor bills a session from creation until termination, so a half-built one
    // has to be torn down here — dropping the reference just leaves a GPU running.
    disposed = true
    await client.disconnect(false).catch(() => undefined)
    throw e instanceof WorldProviderError ? e : new WorldProviderError(`Reactor session failed: ${errorText(e)}`)
  }

  return {
    capabilities: { ...capabilities, note: seedNote(seed, capabilities.note) },

    mount(container: HTMLElement): void {
      container.appendChild(video)
      // A stream attached while the element was still detached does not always
      // start on its own; muted autoplay is allowed, so this is safe to ask for.
      void video.play().catch(() => undefined)
    },

    async sendEvent(event: WorldEvent): Promise<void> {
      if (disposed) return
      // types.ts: commands answer to heldCommands, prose to promptableEvents.
      const gate = event.kind === 'command' ? capabilities.heldCommands : capabilities.promptableEvents
      if (!gate) return
      const commands = event.kind === 'command' ? driveCommands(event.value) : promptCommand(event.value)
      try {
        for (const command of commands) await client.sendCommand(command.name, command.data)
      } catch (e) {
        throw new WorldProviderError(`Reactor refused the ${event.kind} event: ${errorText(e)}`)
      }
    },

    onEnded(handler: (reason: string) => void): () => void {
      // Replay to a late subscriber. PlayModal subscribes only AFTER connect()
      // resolves, so a session that dies inside that window used to leave the
      // modal on "connecting…" with no reason ever delivered. The other three
      // providers already do this; this one did not.
      if (endedReason !== null) {
        const reason = endedReason
        queueMicrotask(() => handler(reason))
        return () => {}
      }
      endedHandlers.add(handler)
      return () => endedHandlers.delete(handler)
    },

    async dispose(): Promise<void> {
      if (disposed) return
      disposed = true
      endedHandlers.clear()
      video.srcObject = null
      video.remove()
      // Terminate, never a recoverable disconnect: recoverable keeps the GPU — and
      // the meter — alive for 30s after the user has already walked away.
      await client.disconnect(false).catch(() => undefined)
    },
  }
}

async function seedWorld(client: ReactorClientLike, options: WorldConnectOptions): Promise<SeedReport> {
  const report: SeedReport = { prompt: false, image: false }
  // ORDER IS LOAD-BEARING, learned from the production player and a recorded
  // live run of this very adapter: the image goes first and must be
  // ACKNOWLEDGED (image_accepted) before anything else — lingbot-world-2
  // ingests the frame asynchronously, and a `start` that arrives before the
  // ack leaves the model running with nothing to draw from: an open, billed,
  // permanently black session. Then the prompt, then start.
  if (options.firstFrameUrl) {
    // A seed frame is an IMPROVEMENT, not a precondition for opening a session.
    // This used to throw straight out of openSession's try, whose catch tears the
    // session down and rethrows — so a 404 cover, an expired signed URL, a host
    // without CORS headers, or simply being offline turned a world that played
    // perfectly well unseeded into one that refused to open at all. Degrade
    // instead, and tell the caller what was lost.
    try {
      await setSeedImage(client, options.firstFrameUrl, options.signal)
      report.image = true
    } catch (e) {
      if (e instanceof WorldProviderError && e.status === 0) throw e   // cancelled
      report.imageError = errorText(e)
    }
  }
  if (options.prompt) {
    await client.sendCommand('set_prompt', { prompt: clampPrompt(options.prompt) })
    report.prompt = true
  }
  // lingbot-world-2 refuses `start` without both a prompt and an image; other
  // Reactor models start on a prompt alone. Ask either way and let the model's own
  // command_error be the authority on what it was missing.
  await client.sendCommand('start', {})
  return report
}

/** What the model was actually given to start from. Surfaced in `capabilities.note`. */
interface SeedReport {
  prompt: boolean
  image: boolean
  imageError?: string
}

/**
 * Say what the model was started with. `lingbot-world-2` will not begin
 * generating without BOTH a prompt and a first frame, and a session that was
 * started without one looks identical to a broken transport: ready, one track,
 * and a black rectangle. Naming the missing half is the difference between a
 * mystery and a fix.
 */
function seedNote(seed: SeedReport, existing: string | undefined): string | undefined {
  const parts: string[] = []
  if (seed.imageError) parts.push(`the first frame could not be loaded (${seed.imageError}), so the session started without it`)
  else if (seed.prompt && !seed.image) parts.push('started from a prompt with no first frame — lingbot-world-2 will not begin generating without both, so paint a seed frame if the picture stays black')
  else if (!seed.prompt && !seed.image) parts.push('started with neither a prompt nor a first frame')
  if (parts.length === 0) return existing
  return existing ? `${existing} ${parts.join('; ')}` : parts.join('; ')
}

async function setSeedImage(client: ReactorClientLike, url: string, signal?: AbortSignal | undefined): Promise<void> {
  if (!client.uploadFile) {
    throw new WorldProviderError('this Reactor runtime cannot upload a first frame (no uploadFile)')
  }
  let blob: Blob
  try {
    const res = await fetch(url, signal ? { signal } : {})
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    blob = await res.blob()
  } catch (e) {
    if (e instanceof Error && e.name === 'AbortError') throw new WorldProviderError('cancelled', 0)
    // The frame is fetched by THIS page, so it has to be same-origin or CORS-open —
    // a URL that works in a new tab can still fail here.
    throw new WorldProviderError(`could not read the first frame at ${url} (${errorText(e)})`)
  }
  // connect() resolves on TRANSPORT readiness, but the coordinator refuses
  // uploads until the SESSION reports ready — an upload fired straight after
  // connect races that state and dies with `status is "waiting". Must be
  // "ready".` (watched happen on a recorded live run; the world then opened
  // black because lingbot-world-2 will not start unseeded). Retry on exactly
  // that refusal, bounded, so a genuinely broken upload still fails loudly.
  const file = new File([blob], 'first-frame.jpg', { type: blob.type || 'image/jpeg' })
  let ref: unknown
  for (let attempt = 1; ; attempt++) {
    try {
      ref = await client.uploadFile(file, { name: 'first-frame.jpg' })
      break
    } catch (e) {
      if (signal?.aborted) throw new WorldProviderError('cancelled', 0)
      if (attempt >= 8 || !/must be "?ready"?/i.test(errorText(e))) throw e
      await new Promise((r) => setTimeout(r, 700))
    }
  }

  // The model ingests the frame ASYNCHRONOUSLY: set_image answers with an
  // image_accepted message (or a command_error) later. Park on that ack before
  // returning — the production player does exactly this, and skipping it means
  // `start` overtakes the ingest and the session generates nothing. The SDK
  // interface exposes on() but no off(), so the listener one-shots itself.
  let settled = false
  const acked = new Promise<void>((resolve, reject) => {
    client.on('message', (payload: unknown) => {
      if (settled || !isRecord(payload)) return
      const type = typeof payload['type'] === 'string' ? payload['type'] : ''
      if (type === 'image_accepted') {
        settled = true
        resolve()
      } else if (type === 'command_error') {
        settled = true
        const detail = typeof payload['error'] === 'string' ? payload['error'] : 'command_error'
        reject(new WorldProviderError(`the model refused the first frame: ${detail}`))
      }
    })
  })
  await client.sendCommand('set_image', { image: ref })
  let ackTimeout: ReturnType<typeof setTimeout> | undefined
  try {
    await Promise.race([
      acked,
      new Promise<never>((_, reject) => {
        ackTimeout = setTimeout(() => {
          reject(new WorldProviderError('the model never acknowledged the first frame (no image_accepted in 20s)'))
        }, 20_000)
      }),
    ])
  } finally {
    settled = true
    if (ackTimeout) clearTimeout(ackTimeout)
  }
}

interface ModelCommand {
  name: string
  data: Record<string, unknown>
}

function promptCommand(value: string): ModelCommand[] {
  return [{ name: 'set_prompt', data: { prompt: clampPrompt(value) } }]
}

/** Over-long prompts come back as a command_error nobody sees, so cut them here. */
function clampPrompt(value: string): string {
  return value.length > MAX_PROMPT_CHARS ? value.slice(0, MAX_PROMPT_CHARS) : value
}

const MOVEMENT: Record<string, string> = {
  front: 'forward', forward: 'forward', w: 'forward',
  back: 'back', backward: 'back', s: 'back',
  left: 'strafe_left', strafe_left: 'strafe_left', a: 'strafe_left',
  right: 'strafe_right', strafe_right: 'strafe_right', d: 'strafe_right',
}
// lingbot-world-2 splits movement into TWO commands — set_move_longitudinal and
// set_move_lateral — and has no set_movement at all. The old table sent every
// move to a command the model ignored, which is why W/A/S/D did nothing while
// the look commands (whose names happen to match) turned the camera.
const LONGITUDINAL: Record<string, true> = { front: true, forward: true, w: true, back: true, backward: true, s: true }
const LOOK_HORIZONTAL: Record<string, string> = {
  look_left: 'left', turn_left: 'left', mouse_left: 'left', q: 'left',
  look_right: 'right', turn_right: 'right', mouse_right: 'right', e: 'right',
}
const LOOK_VERTICAL: Record<string, string> = {
  look_up: 'up', up: 'up',
  look_down: 'down', down: 'down',
}
const STOP = new Set(['idle', 'none', 'stop', 'still'])
/** Per-axis idle tokens sent on keyup: these commands are PERSISTENT on
 *  lingbot-world-2 — a value holds across chunks until changed back to idle —
 *  so a released key must explicitly idle its axis. */
const AXIS_IDLE: Record<string, ModelCommand> = {
  stop_move_longitudinal: { name: 'set_move_longitudinal', data: { move_longitudinal: 'idle' } },
  stop_move_lateral: { name: 'set_move_lateral', data: { move_lateral: 'idle' } },
  stop_look_horizontal: { name: 'set_look_horizontal', data: { look_horizontal: 'idle' } },
  stop_look_vertical: { name: 'set_look_vertical', data: { look_vertical: 'idle' } },
}

/**
 * Translate a studio command token ("Front", "Mouse_Left", "idle") into Reactor
 * drive commands. These are HELD state, not pulses: a value stays applied until
 * something replaces it, which is why "idle" has to clear all three axes.
 *
 * An unknown token throws instead of resolving quietly — an authored beat that
 * addresses a control the model does not have is a bug worth seeing.
 */
/** Exposed for the one test that pins the LOOK vocabulary against the keys the
 *  player binds to it — the two drifted apart once, in a way only a live
 *  session showed. */
export function driveCommandsForTest(value: string): ModelCommand[] {
  return driveCommands(value)
}

function driveCommands(value: string): ModelCommand[] {
  const token = value.trim().toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '')
  if (STOP.has(token)) {
    return [
      { name: 'set_move_longitudinal', data: { move_longitudinal: 'idle' } },
      { name: 'set_move_lateral', data: { move_lateral: 'idle' } },
      { name: 'set_look_horizontal', data: { look_horizontal: 'idle' } },
      { name: 'set_look_vertical', data: { look_vertical: 'idle' } },
    ]
  }
  if (AXIS_IDLE[token]) return [AXIS_IDLE[token]]
  if (MOVEMENT[token]) {
    return LONGITUDINAL[token]
      ? [{ name: 'set_move_longitudinal', data: { move_longitudinal: MOVEMENT[token] } }]
      : [{ name: 'set_move_lateral', data: { move_lateral: MOVEMENT[token] } }]
  }
  if (LOOK_HORIZONTAL[token]) return [{ name: 'set_look_horizontal', data: { look_horizontal: LOOK_HORIZONTAL[token] } }]
  if (LOOK_VERTICAL[token]) return [{ name: 'set_look_vertical', data: { look_vertical: LOOK_VERTICAL[token] } }]
  throw new WorldProviderError(`Reactor has no control called "${value}"`)
}

// ─── Small helpers ───────────────────────────────────────────────────────────

function createVideoElement(): HTMLVideoElement {
  const video = document.createElement('video')
  video.autoplay = true
  video.playsInline = true
  // Browsers block autoplay with sound until a gesture; muted always plays.
  video.muted = true
  video.style.cssText = 'width:100%;height:100%;border:0;background:var(--media-bg);border-radius:8px;object-fit:contain'
  return video
}

function throwIfAborted(signal?: AbortSignal | undefined): void {
  if (signal?.aborted) throw new WorldProviderError('cancelled')
}

function errorText(e: unknown): string {
  if (e instanceof Error) return e.message
  if (typeof e === 'string') return e
  // SDK errors are often plain objects; JSON reads better than "[object Object]".
  return JSON.stringify(e) ?? String(e)
}
