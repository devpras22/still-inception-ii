/**
 * Generic WebSocket world provider — point the studio at YOUR world model.
 *
 * This is the file that makes the studio not-a-client-of-one-vendor. Anything
 * that can hold a WebSocket open and push pictures down it can be played,
 * edited and driven from here: a Modal endpoint, a laptop running a diffusion
 * world model behind `ws://localhost:8765`, a research rig on a Tailscale
 * address, a hosted product that is not ours.
 *
 * ══════════════════════════════════════════════════════════════════════════════
 * THE WIRE PROTOCOL  (studio dialect, version 1)
 * ══════════════════════════════════════════════════════════════════════════════
 * Everything below is JSON text frames, except pictures, which may be binary.
 * Unknown message types MUST be ignored by both sides — that is what makes the
 * protocol extensible without a version negotiation dance.
 *
 * ── Auth ──────────────────────────────────────────────────────────────────────
 * The key, when set, is appended to the URL as `?key=<key>`:
 *
 *     wss://your-host/world?key=sk_live_…
 *
 * Why the query string and not an `Authorization` header: browsers do not let
 * you set headers on a WebSocket handshake. The only two smuggling routes are
 * the query string and the `Sec-WebSocket-Protocol` header (the "Authorization
 * subprotocol" trick). The subprotocol route is prettier — keys stay out of
 * access logs — but it only works if the server echoes the exact token back in
 * its handshake response; a server that ignores it fails the whole connection,
 * so "your key is wrong" becomes indistinguishable from "your server is a
 * normal server". A studio that must work against backends written by people
 * who never read this file cannot afford that failure mode, so: query string.
 *
 * Consequences you should know about: use `wss://` (the query string is then
 * inside TLS), expect the key to appear in your server's access log, and
 * prefer a scoped/short-lived key. If your endpoint already carries its own
 * `key` parameter the studio leaves it alone.
 *
 * ── Client → server ───────────────────────────────────────────────────────────
 *   {"type":"hello","studio":"0.1.0","protocol":1}
 *       First message on every connection, including after a reconnect.
 *
 *   {"type":"start","worldId":"w_123","prompt":"…","firstFrameUrl":"https://…",
 *    "resume":false}
 *       Begin (or, with resume:true, re-enter) a session. HELLO AND START ARE
 *       DELIBERATELY SEPARATE MESSAGES: the studio probes capabilities by
 *       sending `hello` alone and hanging up, so a server that only allocates a
 *       GPU on `start` is never billed for a capability check. Please put your
 *       expensive work behind `start`.
 *
 *   {"type":"event","kind":"prompt"|"state"|"command","value":"…",
 *    "stateId":"cellar"}
 *       An authored beat. `prompt`/`state` are prose — the state machine's
 *       current instruction to the world. `command` is a discrete input token
 *       ("Front", "Left", "Look up") and may arrive at input rate.
 *
 *   {"type":"bye"}
 *       Sent best-effort before a clean close so the server can release the
 *       session instead of waiting for a socket timeout.
 *
 * ── Server → client ───────────────────────────────────────────────────────────
 *   {"type":"capabilities","streaming":true,"promptableEvents":true,
 *    "heldCommands":false,"persistentWorlds":false,"note":"…"}
 *       SHOULD be the first reply to `hello`. Omitted booleans default to
 *       FALSE (except `streaming`, which defaults true — you answered, so you
 *       presumably draw). `note` is shown verbatim in the studio UI, so it is a
 *       good place for "events land on the next keyframe, ~400ms".
 *
 *   <binary>                       one encoded image: PNG / JPEG / WebP / GIF.
 *   {"type":"frame","url":"https://…"}          picture at a URL.
 *   {"type":"frame","format":"rgba","width":320,"height":180}
 *       …followed immediately by one binary message of width*height*4 bytes.
 *       (The legacy inline header `[0x01][w u16le][h u16le][rgba…]` is also
 *       accepted, so existing Alakazam-runtime servers work unchanged.)
 *
 *   {"type":"video","url":"https://…"}
 *       Hand off to a media element: HLS/DASH/MP4/WebM, anything the browser
 *       plays natively. Use this instead of frame-pushing when you already
 *       have a media stream — it is dramatically cheaper than JSON+base64.
 *
 *   {"type":"ended","reason":"out of credit"}   session over; no reconnect.
 *   {"type":"error","message":"…"}              surfaced to the console; not fatal.
 *
 * ── If you answer nothing at all ──────────────────────────────────────────────
 * The studio does not fail. After a short timeout it infers: `streaming` from
 * whether a picture actually arrived, and everything else FALSE — in
 * particular `promptableEvents`, because a backend that streams pretty frames
 * but ignores authored events is the single most confusing failure this studio
 * can have (transitions fire, the HUD updates, the picture ignores all of it).
 * Guessing "true" there costs the user an hour; guessing "false" costs one
 * dismissible warning. The inferred capabilities carry a `note` saying so.
 *
 * ── Reconnect ─────────────────────────────────────────────────────────────────
 * Abnormal closes are retried with bounded exponential backoff (5 attempts,
 * 0.5s → 8s, jittered). On reconnect the studio re-sends `hello`, then `start`
 * with `resume:true`, then replays the last `state` event only — stale prompts
 * and stale movement commands are dropped on purpose, because replaying a
 * ten-second-old "he draws the knife" is worse than replaying nothing. A clean
 * close (code 1000), an explicit `ended`, or a rejected key (1008/4401/4403)
 * ends the session instead of retrying. If that happens inside the opening
 * handshake it surfaces as a thrown error from connect() rather than as a
 * session that exists but can never draw.
 *
 * ── A minimal conforming server (Node, `ws`) ──────────────────────────────────
 *     wss.on('connection', (sock) => {
 *       sock.on('message', (raw) => {
 *         const m = JSON.parse(String(raw))
 *         if (m.type === 'hello') sock.send(JSON.stringify({
 *           type: 'capabilities', streaming: true, promptableEvents: true,
 *           heldCommands: false, persistentWorlds: false,
 *           note: 'events apply on the next keyframe' }))
 *         if (m.type === 'start') startRendering(m.prompt, (jpeg) => sock.send(jpeg))
 *         if (m.type === 'event') applyEvent(m.kind, m.value)
 *       })
 *     })
 */

import { NO_CAPABILITIES, WorldProviderError } from '../types'
import type {
  ProviderConfig,
  WorldCapabilities,
  WorldConnectOptions,
  WorldEvent,
  WorldModelProvider,
  WorldSession,
} from '../types'

export type WebSocketWorldConfig = ProviderConfig['world']['websocket']

/** Bumped only for a breaking change to the message shapes above. */
export const WS_PROTOCOL_VERSION = 1
const STUDIO_VERSION = '0.1.0'

/**
 * Long enough for a transatlantic round trip plus a cold Python handler, short
 * enough that a server which will never answer does not hold Play hostage.
 */
const HANDSHAKE_TIMEOUT_MS = 2500
/** probe() listens a little past the handshake: a frame is itself evidence. */
const PROBE_TOTAL_MS = 5000
/** Browsers surface no connect timeout, so we drive one; otherwise a black-hole
 *  host hangs for the OS TCP timeout (~75s) with a spinner on screen. */
const OPEN_TIMEOUT_MS = 8000
const RECONNECT_MAX_ATTEMPTS = 5
const RECONNECT_BASE_MS = 500
const RECONNECT_CAP_MS = 8000
/** Lifetime ceiling for one session, on top of the per-outage attempt budget. */
const RECONNECT_TOTAL_BUDGET = 20
/** Superseded object URLs waiting for a decode to confirm they are dead. */
const MAX_STALE_OBJECT_URLS = 8

/** Codes where retrying only burns the server's rate limit: it said no on purpose. */
const FATAL_CLOSE_CODES = new Set([1003, 1008, 4401, 4403])

type Timer = ReturnType<typeof setTimeout>
/** `alakazam` is the Alakazam runtime's older dialect (init/ready/action ints). */
type Dialect = 'studio' | 'alakazam'

// ── Endpoint resolution ──────────────────────────────────────────────────────

interface Endpoint {
  url: string | null
  /** Why `url` is null, in words a user can act on. */
  error?: string
  /** Key would travel unencrypted — worth saying out loud, not worth blocking. */
  insecure?: boolean
}

function isLoopback(host: string): boolean {
  return host === 'localhost' || host === '127.0.0.1' || host === '::1' || host === '[::1]' || host.endsWith('.localhost')
}

function resolveEndpoint(cfg: WebSocketWorldConfig): Endpoint {
  const raw = (cfg.url || '').trim()
  if (!raw) return { url: null, error: 'No WebSocket URL set — add one in Settings → World model.' }
  // A pasted https:// endpoint is nearly always the right host with the wrong
  // scheme. Fixing it beats making the user re-read the label.
  const swapped = raw.replace(/^http(s?):\/\//i, 'ws$1://')
  let u: URL
  try {
    u = new URL(swapped)
  } catch {
    return { url: null, error: `"${raw}" is not a URL. Expected ws://host/path or wss://host/path.` }
  }
  if (u.protocol !== 'ws:' && u.protocol !== 'wss:') {
    return { url: null, error: `Unsupported scheme "${u.protocol}" — use ws:// or wss://.` }
  }
  const key = (cfg.apiKey || '').trim()
  if (key && !u.searchParams.has('key')) u.searchParams.set('key', key)
  return { url: u.toString(), insecure: !!key && u.protocol === 'ws:' && !isLoopback(u.hostname) }
}

/** Never let a key reach a console line or an error toast. */
/**
 * Endpoint URLs get logged and shown in errors, so anything credential-shaped in
 * one has to be masked. Matching only a param literally named `key` meant a
 * server documented as `?token=` or `?api_key=` printed the secret in full —
 * and userinfo (`wss://user:secret@host`) was never touched at all.
 */
const SECRET_PARAM = /(^|[_-])(key|token|secret|password|auth|credential|sig|signature)([_-]|$)/i

function redact(url: string): string {
  try {
    const u = new URL(url)
    for (const name of [...u.searchParams.keys()]) {
      if (SECRET_PARAM.test(name)) u.searchParams.set(name, '…')
    }
    // wss://user:secret@host — the password half is a credential too.
    if (u.password) u.password = '…'
    return u.toString()
  } catch {
    return url
  }
}

// ── Message parsing (defensive: this is somebody else's server) ──────────────

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}
function asRecord(v: unknown): Record<string, unknown> | null {
  return isRecord(v) ? v : null
}
function str(v: unknown): string | undefined {
  return typeof v === 'string' && v.length > 0 ? v : undefined
}
function bool(v: unknown): boolean | undefined {
  return typeof v === 'boolean' ? v : undefined
}
function num(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined
}
function joinNotes(...parts: (string | undefined)[]): string | undefined {
  const kept = parts.filter((p): p is string => !!p && p.trim().length > 0)
  return kept.length > 0 ? kept.join(' ') : undefined
}
const INSECURE_NOTE = 'Your key is travelling over an unencrypted ws:// connection — use wss:// for anything but localhost.'

function withInsecure(caps: WorldCapabilities, insecure: boolean | undefined): WorldCapabilities {
  if (!insecure) return caps
  return { ...caps, note: joinNotes(caps.note, INSECURE_NOTE) }
}

/** Missing booleans mean NO. The one exception is `streaming`: a server that
 *  bothered to answer the handshake is a server that draws. */
function capsFromDeclaration(msg: Record<string, unknown>): WorldCapabilities {
  return {
    streaming: bool(msg["streaming"]) ?? true,
    promptableEvents: bool(msg["promptableEvents"]) ?? false,
    heldCommands: bool(msg["heldCommands"]) ?? false,
    persistentWorlds: bool(msg["persistentWorlds"]) ?? false,
    note: str(msg["note"]),
  }
}

/**
 * The Alakazam runtime answers `init` with `ready` + a model config. It has no
 * authored-event channel at all — it takes action integers — so promptableEvents
 * stays false unless the config explicitly opts into the studio event envelope.
 */
function capsFromReady(msg: Record<string, unknown>): { caps: WorldCapabilities; actionNames: string[] } {
  const config = asRecord(msg["config"]) ?? {}
  const rawNames = Array.isArray(config["actionNames"]) ? config["actionNames"] : []
  const actionNames = rawNames.filter((n): n is string => typeof n === 'string')
  const numActions = num(config["numActions"]) ?? actionNames.length
  const promptable = bool(config["promptableEvents"]) ?? false
  return {
    actionNames,
    caps: {
      streaming: true,
      promptableEvents: promptable,
      heldCommands: numActions > 0,
      persistentWorlds: bool(config["persistentWorlds"]) ?? false,
      note: joinNotes(
        str(config["name"]) ? `Model: ${str(config["name"])}.` : undefined,
        'Alakazam runtime dialect (init/ready/action).',
        promptable ? undefined : 'It takes discrete actions only, so authored world events will not change the picture.',
      ),
    },
  }
}

function inferredCapabilities(sawFrame: boolean, phase: 'session' | 'probe'): WorldCapabilities {
  const why =
    'Capabilities were INFERRED, not declared: the server never answered the {"type":"hello"} handshake. ' +
    'Authored world events are assumed unsupported — the safe guess, since a world that ignores them looks identical to one that works. ' +
    'Reply to hello with a {"type":"capabilities"} message to replace this guess with the truth.'
  const observed = sawFrame
    ? 'Frames were seen, so it does stream.'
    : phase === 'probe'
      ? 'No frames were seen, but the probe never sends "start" (so a server that renders on demand costs nothing to probe) — press Play to find out.'
      : 'No frames arrived either.'
  return {
    streaming: sawFrame,
    promptableEvents: false,
    heldCommands: false,
    persistentWorlds: false,
    note: `${why} ${observed}`,
  }
}

// ── Picture surface ──────────────────────────────────────────────────────────

// Fill the player, don't sit at intrinsic size in the middle of it.
//
// A world model's native resolution is its own business: the doc's own
// reference server sends 160x90, and painted at intrinsic size that is a ~13%
// postage stamp centred in a black rectangle. `max-*:100%` caps but never
// scales up, and `object-fit` is inert on a canvas whose CSS box already equals
// its bitmap. So the first thing anyone integrating their own model saw looked
// broken. Give the element the whole box and let object-fit letterbox it, and
// keep pixel art crisp rather than smeared while it is scaled.
const MEDIA_CSS =
  'width:100%;height:100%;object-fit:contain;display:block;image-rendering:pixelated'

/**
 * Owns every DOM node and every object URL the session creates. Kept apart from
 * the socket so that a reconnect swaps the transport without blanking the
 * picture — a frozen last frame reads as "buffering", a black rectangle reads
 * as "broken".
 */
class Surface {
  readonly root: HTMLDivElement
  private img: HTMLImageElement | null = null
  private canvas: HTMLCanvasElement | null = null
  private ctx: CanvasRenderingContext2D | null = null
  private video: HTMLVideoElement | null = null
  private current: string | null = null
  private stale: string[] = []

  constructor() {
    const root = document.createElement('div')
    root.className = 'ws-world-surface'
    root.style.cssText =
      'position:relative;width:100%;height:100%;display:flex;align-items:center;justify-content:center;background:var(--media-bg);overflow:hidden'
    this.root = root
  }

  paintBytes(bytes: ArrayBuffer, mime: string): void {
    this.paintUrl(URL.createObjectURL(new Blob([bytes], { type: mime })), true)
  }

  paintUrl(url: string, revocable: boolean): void {
    const img = this.ensureImg()
    if (this.current) this.stale.push(this.current)
    this.current = revocable ? url : null
    // A run of cancelled loads can starve the onload flush; cap the backlog.
    if (this.stale.length > MAX_STALE_OBJECT_URLS) this.flushStale()
    img.src = url
    this.showOnly(img)
  }

  paintRgba(bytes: Uint8Array, width: number, height: number): void {
    const canvas = this.ensureCanvas()
    if (canvas.width !== width || canvas.height !== height) {
      canvas.width = width
      canvas.height = height
    }
    if (!this.ctx) return
    this.ctx.putImageData(new ImageData(new Uint8ClampedArray(bytes), width, height), 0, 0)
    this.showOnly(canvas)
  }

  playVideo(url: string): void {
    const video = this.ensureVideo()
    if (video.src !== url) video.src = url
    // Autoplay can be refused (no user gesture); the element still shows its
    // first frame and the user can hit play, so a rejection is not an error.
    void video.play().catch(() => {})
    this.showOnly(video)
  }

  destroy(): void {
    this.flushStale()
    if (this.current) {
      URL.revokeObjectURL(this.current)
      this.current = null
    }
    if (this.video) {
      // Dropping the element is not enough: without this the browser keeps
      // pulling the media stream in the background.
      this.video.pause()
      this.video.removeAttribute('src')
      this.video.load()
    }
    this.root.remove()
    this.img = null
    this.canvas = null
    this.ctx = null
    this.video = null
  }

  private ensureImg(): HTMLImageElement {
    if (!this.img) {
      const img = document.createElement('img')
      img.alt = ''
      img.style.cssText = MEDIA_CSS
      // Revoke superseded URLs only once a later frame has actually decoded:
      // revoking one the <img> is still fetching drops the live frame in Safari.
      img.onload = () => this.flushStale()
      img.onerror = () => this.flushStale()
      this.root.appendChild(img)
      this.img = img
    }
    return this.img
  }

  private ensureCanvas(): HTMLCanvasElement {
    if (!this.canvas) {
      const canvas = document.createElement('canvas')
      canvas.style.cssText = MEDIA_CSS
      this.root.appendChild(canvas)
      this.canvas = canvas
      this.ctx = canvas.getContext('2d')
    }
    return this.canvas
  }

  private ensureVideo(): HTMLVideoElement {
    if (!this.video) {
      const video = document.createElement('video')
      video.style.cssText = MEDIA_CSS
      video.autoplay = true
      video.muted = true // muted autoplay is the only autoplay browsers allow
      video.controls = false
      video.setAttribute('playsinline', '')
      this.root.appendChild(video)
      this.video = video
    }
    return this.video
  }

  private showOnly(el: HTMLElement): void {
    for (const node of [this.img, this.canvas, this.video]) {
      if (node) node.style.display = node === el ? 'block' : 'none'
    }
  }

  private flushStale(): void {
    for (const url of this.stale) URL.revokeObjectURL(url)
    this.stale.length = 0
  }
}

function sniffImageMime(bytes: Uint8Array): string | null {
  if (bytes.length < 12) return null
  if (bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) return 'image/png'
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'image/jpeg'
  if (bytes[0] === 0x47 && bytes[1] === 0x49 && bytes[2] === 0x46) return 'image/gif'
  const riff = bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46
  const webp = bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50
  if (riff && webp) return 'image/webp'
  return null
}

/** Legacy inline header: [0x01][width u16le][height u16le][rgba…]. */
function parseRgbaHeader(buf: ArrayBuffer): { width: number; height: number; offset: number } | null {
  if (buf.byteLength < 5) return null
  const view = new DataView(buf)
  if (view.getUint8(0) !== 0x01) return null
  const width = view.getUint16(1, true)
  const height = view.getUint16(3, true)
  if (width <= 0 || height <= 0) return null
  if (buf.byteLength - 5 < width * height * 4) return null
  return { width, height, offset: 5 }
}

function detach(ws: WebSocket): void {
  ws.onopen = null
  ws.onmessage = null
  ws.onerror = null
  ws.onclose = null
}

function closeQuietly(ws: WebSocket, code: number, reason: string): void {
  try {
    if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) ws.close(code, reason)
  } catch {
    /* already closing — nothing to do */
  }
}

function errText(e: unknown): string {
  return e instanceof Error ? e.message : String(e)
}

// ── Session ──────────────────────────────────────────────────────────────────

class WebSocketWorldSession implements WorldSession {
  private readonly endpoint: Endpoint
  private readonly cfg: WebSocketWorldConfig
  private readonly options: WorldConnectOptions
  private readonly url: string

  private ws: WebSocket | null = null
  private caps: WorldCapabilities = { ...NO_CAPABILITIES }
  private declared = false
  private dialect: Dialect = 'studio'
  private actionNames: string[] = []

  private surface: Surface | null = null
  private container: HTMLElement | null = null

  private handshakeResolve: (() => void) | null = null
  private handshakeSettled = false
  private handshakeTimer: Timer | null = null
  private reconnectTimer: Timer | null = null
  private openTimer: Timer | null = null
  /** Set while a connect is in flight, so dispose() can end it. */
  private settleOpen: ((err?: WorldProviderError) => void) | null = null

  private attempts = 0
  private totalReconnects = 0
  private triedAlakazamHandshake = false
  private sawFrame = false
  private started = false
  private pendingLayout: { width: number; height: number } | null = null
  private lastState: WorldEvent | null = null

  private disposed = false
  private ended = false
  private endReason: string | null = null
  private warnedNoEvents = false
  private warnedUnknownBinary = false
  private lastOfflineWarn = 0
  private endedHandlers = new Set<(reason: string) => void>()

  constructor(endpoint: Endpoint, cfg: WebSocketWorldConfig, options: WorldConnectOptions) {
    this.endpoint = endpoint
    this.cfg = cfg
    this.options = options
    this.url = endpoint.url ?? ''
    this.dialect = cfg.protocol === 'alakazam-ws' ? 'alakazam' : 'studio'
  }

  // WorldSession ─────────────────────────────────────────────────────────────

  get capabilities(): WorldCapabilities {
    return withInsecure(this.caps, this.endpoint.insecure)
  }

  mount(container: HTMLElement): void {
    if (this.disposed) return
    const surface = this.ensureSurface()
    // Idempotent, and re-mounting elsewhere MOVES the same surface rather than
    // rebuilding it, so the last frame survives a React remount.
    if (this.container === container && surface.root.parentNode === container) return
    container.appendChild(surface.root)
    this.container = container
  }

  async sendEvent(event: WorldEvent): Promise<void> {
    if (this.disposed || this.ended) return
    // Remembered even when it cannot be sent: this is what a reconnect replays.
    if (event.kind === 'state') this.lastState = event

    // Held input is gated on heldCommands, authored beats on promptableEvents.
    // A WASD-only world model declares heldCommands without promptableEvents and
    // would be unplayable if we dropped its input too.
    // types.ts: commands answer to heldCommands, prose to promptableEvents.
    const allowed = event.kind === 'command' ? this.caps.heldCommands : this.caps.promptableEvents
    if (!allowed) {
      this.warnDropped(event)
      return
    }
    if (!this.sendOnWire(event)) this.warnOffline(event)
  }

  onEnded(handler: (reason: string) => void): () => void {
    this.endedHandlers.add(handler)
    // A session can die before its owner subscribes (a key refused mid-connect).
    // Replaying the terminal reason to a late subscriber is the difference
    // between "the player says why it stopped" and a frozen frame with no
    // explanation. Deferred so the caller still gets its unsubscribe first.
    if (this.ended && this.endReason !== null) {
      const reason = this.endReason
      queueMicrotask(() => {
        if (this.endedHandlers.has(handler)) handler(reason)
      })
    }
    return () => {
      this.endedHandlers.delete(handler)
    }
  }

  async dispose(): Promise<void> {
    if (this.disposed) return
    this.disposed = true
    this.clearTimers()
    this.send({ type: 'bye' })
    this.closeSocket(1000, 'studio closed the session')
    this.surface?.destroy()
    this.surface = null
    this.container = null
    this.endedHandlers.clear()
    // Anything awaiting the handshake (an aborted connect) must not hang.
    const resolve = this.handshakeResolve
    this.handshakeResolve = null
    resolve?.()
    // Same for a socket still opening: closeSocket() above detached the handlers
    // that were the only things able to settle connectSocket()'s promise.
    const settle = this.settleOpen
    this.settleOpen = null
    settle?.(new WorldProviderError('connection aborted'))
  }

  // Connect ──────────────────────────────────────────────────────────────────

  /** Resolves once the socket is open AND capabilities are known (declared or
   *  inferred). Rejects only when the socket cannot be opened at all. */
  async open(): Promise<void> {
    const signal = this.options.signal
    if (signal?.aborted) throw new WorldProviderError('connection aborted')
    const onAbort = () => {
      void this.dispose()
    }
    signal?.addEventListener('abort', onAbort, { once: true })
    try {
      await this.connectSocket()
      await new Promise<void>((resolve) => {
        // The handshake can settle before we get here (a server that answers
        // inside the same task); waiting on a resolver nobody will call is how
        // that turns into a hang.
        if (this.handshakeSettled || this.disposed) resolve()
        else this.handshakeResolve = resolve
      })
    } finally {
      signal?.removeEventListener('abort', onAbort)
    }
    if (this.disposed) throw new WorldProviderError('connection aborted')
  }

  private connectSocket(): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      let ws: WebSocket
      try {
        ws = new WebSocket(this.url)
      } catch (e) {
        reject(new WorldProviderError(`could not open ${redact(this.url)}: ${errText(e)}`))
        return
      }
      ws.binaryType = 'arraybuffer'
      this.ws = ws

      let settled = false
      const settle = (err?: WorldProviderError) => {
        if (settled) return
        settled = true
        this.settleOpen = null
        if (this.openTimer) {
          clearTimeout(this.openTimer)
          this.openTimer = null
        }
        if (err) {
          detach(ws)
          closeQuietly(ws, 1000, 'giving up on connect')
          if (this.ws === ws) this.ws = null
          reject(err)
        } else {
          resolve()
        }
      }

      // dispose() detaches these handlers and clears the timer, which used to
      // leave this promise with nothing left able to settle it — so closing the
      // play modal against a slow or black-hole endpoint hung connect() forever.
      // PlayModal aborts on every close and unmount, so that was the normal path.
      this.settleOpen = settle

      this.openTimer = setTimeout(() => {
        settle(new WorldProviderError(`timed out connecting to ${redact(this.url)}`))
      }, OPEN_TIMEOUT_MS)

      ws.onopen = () => {
        ws.onmessage = (ev) => this.handleMessage(ev)
        ws.onerror = () => {
          /* onclose always follows and carries the only useful information */
        }
        ws.onclose = (ev) => this.handleClose(ev)
        this.startHandshake()
        settle()
      }
      ws.onerror = () => {
        settle(
          new WorldProviderError(
            `could not reach ${redact(this.url)} — check the URL, that the server is up, and that it allows this origin`,
          ),
        )
      }
      ws.onclose = (ev) => {
        settle(new WorldProviderError(`${redact(this.url)} closed the connection immediately${closeDetail(ev)}`))
      }
    })
  }

  /** Sent on every connection: a reconnect is a new socket and the server has
   *  no way to know it is the same studio otherwise. */
  private startHandshake(): void {
    this.triedAlakazamHandshake = false
    if (this.dialect === 'alakazam') {
      this.send({ type: 'init', modelId: this.options.worldId })
      this.triedAlakazamHandshake = true
    }
    this.send({ type: 'hello', studio: STUDIO_VERSION, protocol: WS_PROTOCOL_VERSION })
    this.send({
      type: 'start',
      worldId: this.options.worldId,
      prompt: this.options.prompt,
      firstFrameUrl: this.options.firstFrameUrl,
      resume: this.started,
    })
    this.started = true
    if (this.lastState) this.sendOnWire(this.lastState)
    this.armHandshakeTimer()
  }

  private armHandshakeTimer(): void {
    if (this.handshakeTimer) clearTimeout(this.handshakeTimer)
    this.handshakeTimer = setTimeout(() => this.onHandshakeTimeout(), HANDSHAKE_TIMEOUT_MS)
  }

  private onHandshakeTimeout(): void {
    this.handshakeTimer = null
    if (this.disposed) return
    // In `auto` we give the older Alakazam handshake one chance before guessing:
    // that dialect is the one backend we know exists and does not speak `hello`.
    if (this.cfg.protocol === 'auto' && !this.triedAlakazamHandshake) {
      this.triedAlakazamHandshake = true
      this.send({ type: 'init', modelId: this.options.worldId })
      this.armHandshakeTimer()
      return
    }
    this.settleHandshake(inferredCapabilities(this.sawFrame, 'session'), false)
  }

  private settleHandshake(caps: WorldCapabilities, declared: boolean): void {
    if (this.handshakeTimer) {
      clearTimeout(this.handshakeTimer)
      this.handshakeTimer = null
    }
    // A silent reconnect must not downgrade capabilities the server already
    // declared — it declared them about itself, not about that one socket.
    if (declared) {
      this.declared = true
      this.caps = caps
    } else if (!this.declared) {
      this.caps = caps
    }
    this.handshakeSettled = true
    const resolve = this.handshakeResolve
    this.handshakeResolve = null
    resolve?.()
  }

  // Inbound ──────────────────────────────────────────────────────────────────

  private handleMessage(ev: MessageEvent): void {
    if (this.disposed) return
    this.attempts = 0 // traffic proves the endpoint is real; earn the retries back
    const data: unknown = ev.data
    if (typeof data === 'string') {
      this.handleText(data)
    } else if (data instanceof ArrayBuffer) {
      this.handleBinary(data)
    } else if (data instanceof Blob) {
      void data.arrayBuffer().then((buf) => {
        if (!this.disposed) this.handleBinary(buf)
      })
    }
  }

  private handleText(text: string): void {
    let parsed: unknown
    try {
      parsed = JSON.parse(text)
    } catch {
      return // servers log to their own socket more often than you would think
    }
    const msg = asRecord(parsed)
    if (!msg) return
    switch (str(msg["type"])) {
      case 'capabilities':
        this.dialect = 'studio'
        this.settleHandshake(capsFromDeclaration(msg), true)
        break
      case 'ready': {
        const r = capsFromReady(msg)
        this.dialect = 'alakazam'
        this.actionNames = r.actionNames
        this.settleHandshake(r.caps, true)
        break
      }
      case 'frame': {
        const url = str(msg["url"])
        if (url) {
          this.sawFrame = true
          this.ensureSurface().paintUrl(url, false)
          break
        }
        // A layout header describes the NEXT binary message.
        const w = num(msg["width"])
        const h = num(msg["height"])
        if (str(msg["format"]) === 'rgba' && w && h) this.pendingLayout = { width: Math.trunc(w), height: Math.trunc(h) }
        break
      }
      case 'video':
      case 'stream': {
        const url = str(msg["url"])
        if (url) {
          this.sawFrame = true
          this.ensureSurface().playVideo(url)
        }
        break
      }
      case 'ended':
        this.fireEnded(str(msg["reason"]) ?? 'the world model ended the session')
        break
      case 'error':
        console.warn(`[world/websocket] server error: ${str(msg["message"]) ?? str(msg["detail"]) ?? 'unspecified'}`)
        break
      default:
        break // unknown types are ignored by design
    }
  }

  private handleBinary(buf: ArrayBuffer): void {
    const bytes = new Uint8Array(buf)
    const layout = this.pendingLayout
    this.pendingLayout = null

    if (layout) {
      const need = layout.width * layout.height * 4
      if (bytes.byteLength >= need) {
        this.sawFrame = true
        this.ensureSurface().paintRgba(bytes.subarray(0, need), layout.width, layout.height)
        return
      }
    }
    const mime = sniffImageMime(bytes)
    if (mime) {
      this.sawFrame = true
      this.ensureSurface().paintBytes(buf, mime)
      return
    }
    const header = parseRgbaHeader(buf)
    if (header) {
      this.sawFrame = true
      const need = header.width * header.height * 4
      this.ensureSurface().paintRgba(bytes.subarray(header.offset, header.offset + need), header.width, header.height)
      return
    }
    if (!this.warnedUnknownBinary) {
      this.warnedUnknownBinary = true
      console.warn(
        `[world/websocket] ignoring a ${bytes.byteLength}-byte binary message in an unrecognised format. ` +
          'Send PNG/JPEG/WebP/GIF bytes, or announce raw pixels first with {"type":"frame","format":"rgba","width":W,"height":H}.',
      )
    }
  }

  private handleClose(ev: CloseEvent): void {
    if (ev.target === this.ws) this.ws = null
    if (this.disposed || this.ended) return
    // A pending open() must not dangle on a socket that just died.
    if (this.handshakeResolve) this.settleHandshake(inferredCapabilities(this.sawFrame, 'session'), false)

    if (ev.code === 1000) {
      this.fireEnded(ev.reason || 'the server closed the session')
      return
    }
    if (FATAL_CLOSE_CODES.has(ev.code)) {
      this.fireEnded(`the server refused the connection${closeDetail(ev)} — check the key and the URL path`)
      return
    }
    this.scheduleReconnect(`connection lost${closeDetail(ev)}`)
  }

  // Outbound ─────────────────────────────────────────────────────────────────

  private send(msg: Record<string, unknown>): boolean {
    const ws = this.ws
    if (!ws || ws.readyState !== WebSocket.OPEN) return false
    try {
      ws.send(JSON.stringify(msg))
      return true
    } catch {
      return false
    }
  }

  private sendOnWire(event: WorldEvent): boolean {
    // The Alakazam dialect has no event channel, only action integers — map the
    // command onto one when we know its name, otherwise fall through to the
    // studio envelope (a server that declared promptableEvents accepts it).
    if (this.dialect === 'alakazam' && event.kind === 'command') {
      const wanted = event.value.trim().toLowerCase()
      const index = this.actionNames.findIndex((n) => n.toLowerCase() === wanted)
      if (index >= 0) return this.send({ type: 'action', action: index })
    }
    return this.send({ type: 'event', kind: event.kind, value: event.value, stateId: event.stateId })
  }

  private warnDropped(event: WorldEvent): void {
    if (this.warnedNoEvents) return
    this.warnedNoEvents = true
    console.warn(
      `[world/websocket] dropped ${event.kind} "${event.value.slice(0, 60)}": this backend did not declare ` +
        `${event.kind === 'command' ? 'heldCommands' : 'promptableEvents'}. The state machine keeps running; the picture will not follow it.`,
    )
  }

  private warnOffline(event: WorldEvent): void {
    // Held commands arrive at input rate; an unthrottled warning here would bury
    // the console under one message per frame for the length of an outage.
    const now = Date.now()
    if (now - this.lastOfflineWarn < 3000) return
    this.lastOfflineWarn = now
    console.warn(`[world/websocket] socket not open — ${event.kind} event dropped (the latest state is replayed on reconnect)`)
  }

  // Lifecycle ────────────────────────────────────────────────────────────────

  private scheduleReconnect(reason: string): void {
    if (this.disposed || this.ended) return
    if (this.attempts >= RECONNECT_MAX_ATTEMPTS) {
      this.fireEnded(`${reason}; gave up after ${RECONNECT_MAX_ATTEMPTS} reconnect attempts`)
      return
    }
    // Traffic resets `attempts`, so a server that accepts, says one word and
    // hangs up would otherwise reconnect forever. This is the outer stop.
    if (this.totalReconnects >= RECONNECT_TOTAL_BUDGET) {
      this.fireEnded(`${reason}; the connection kept dropping (${this.totalReconnects} reconnects)`)
      return
    }
    const backoff = Math.min(RECONNECT_CAP_MS, Math.round(RECONNECT_BASE_MS * Math.pow(1.8, this.attempts)))
    this.attempts += 1
    this.totalReconnects += 1
    // Jitter so a wall of studio tabs does not resynchronise onto one tick and
    // hammer a server that is already having a bad time.
    this.reconnectTimer = setTimeout(
      () => {
        this.reconnectTimer = null
        if (this.disposed || this.ended) return
        this.connectSocket().catch((e: unknown) => this.scheduleReconnect(errText(e)))
      },
      backoff + Math.floor(Math.random() * 250),
    )
  }

  /** Set once the session is over, so connect() and late subscribers can see it. */
  get terminalReason(): string | null {
    return this.endReason
  }

  private fireEnded(reason: string): void {
    if (this.ended || this.disposed) return
    this.ended = true
    this.endReason = reason
    this.clearTimers()
    // The socket goes, the picture stays: the UI decides what to show next, and
    // yanking the last frame is worse than freezing it.
    this.closeSocket(1000, 'session ended')
    if (this.handshakeResolve) this.settleHandshake(inferredCapabilities(this.sawFrame, 'session'), false)
    for (const handler of [...this.endedHandlers]) {
      try {
        handler(reason)
      } catch (e) {
        console.warn(`[world/websocket] onEnded listener threw: ${errText(e)}`)
      }
    }
  }

  private closeSocket(code: number, reason: string): void {
    const ws = this.ws
    this.ws = null
    if (!ws) return
    // Detach BEFORE closing: a close handler that still fires would schedule a
    // reconnect for a session that no longer exists. That is the socket leak.
    detach(ws)
    closeQuietly(ws, code, reason)
  }

  private clearTimers(): void {
    for (const timer of [this.handshakeTimer, this.reconnectTimer, this.openTimer]) {
      if (timer) clearTimeout(timer)
    }
    this.handshakeTimer = null
    this.reconnectTimer = null
    this.openTimer = null
  }

  private ensureSurface(): Surface {
    if (!this.surface) this.surface = new Surface()
    return this.surface
  }
}

function closeDetail(ev: CloseEvent): string {
  const reason = ev.reason ? `: ${ev.reason}` : ''
  return ` (${ev.code}${reason})`
}

// ── Probe ────────────────────────────────────────────────────────────────────

/**
 * Opens one socket, says `hello`, and hangs up as soon as it has an answer.
 * Never sends `start`, so a server that allocates on `start` pays nothing for a
 * capability check. Never throws — a failed probe is a result, not an error,
 * because the reason is exactly what the user needs to read.
 */
function probeEndpoint(endpoint: Endpoint, cfg: WebSocketWorldConfig, signal?: AbortSignal | undefined): Promise<WorldCapabilities> {
  return new Promise<WorldCapabilities>((resolve) => {
    const url = endpoint.url ?? ''
    let done = false
    let sawFrame = false
    let triedAlakazam = false
    let ws: WebSocket | null = null
    const timers: Timer[] = []

    const finish = (caps: WorldCapabilities) => {
      if (done) return
      done = true
      for (const t of timers) clearTimeout(t)
      signal?.removeEventListener('abort', onAbort)
      if (ws) {
        detach(ws)
        closeQuietly(ws, 1000, 'probe complete')
        ws = null
      }
      resolve(withInsecure(caps, endpoint.insecure))
    }
    const onAbort = () => finish({ ...NO_CAPABILITIES, note: 'Capability probe cancelled.' })
    if (signal?.aborted) {
      onAbort()
      return
    }
    signal?.addEventListener('abort', onAbort, { once: true })

    const send = (msg: Record<string, unknown>) => {
      if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg))
    }

    try {
      ws = new WebSocket(url)
    } catch (e) {
      finish({ ...NO_CAPABILITIES, note: `Could not open ${redact(url)}: ${errText(e)}` })
      return
    }
    ws.binaryType = 'arraybuffer'

    timers.push(setTimeout(() => finish({ ...NO_CAPABILITIES, note: `Timed out connecting to ${redact(url)}.` }), OPEN_TIMEOUT_MS))

    ws.onopen = () => {
      if (cfg.protocol === 'alakazam-ws') {
        triedAlakazam = true
        send({ type: 'init', modelId: 'probe' })
      }
      send({ type: 'hello', studio: STUDIO_VERSION, protocol: WS_PROTOCOL_VERSION })
      timers.push(
        setTimeout(() => {
          if (cfg.protocol === 'auto' && !triedAlakazam) {
            triedAlakazam = true
            send({ type: 'init', modelId: 'probe' })
          }
        }, HANDSHAKE_TIMEOUT_MS),
      )
      timers.push(setTimeout(() => finish(inferredCapabilities(sawFrame, 'probe')), PROBE_TOTAL_MS))
    }
    ws.onmessage = (ev) => {
      const data: unknown = ev.data
      if (typeof data !== 'string') {
        sawFrame = true // any binary payload is a picture in every dialect we speak
        return
      }
      let parsed: unknown
      try {
        parsed = JSON.parse(data)
      } catch {
        return
      }
      const msg = asRecord(parsed)
      if (!msg) return
      const type = str(msg["type"])
      if (type === 'capabilities') finish(capsFromDeclaration(msg))
      else if (type === 'ready') finish(capsFromReady(msg).caps)
      else if (type === 'frame' || type === 'video' || type === 'stream') sawFrame = true
      else if (type === 'ended' || type === 'error') {
        finish({ ...NO_CAPABILITIES, note: `The endpoint answered with ${type}: ${str(msg["reason"]) ?? str(msg["message"]) ?? 'no detail'}.` })
      }
    }
    ws.onerror = () => {
      finish({
        ...NO_CAPABILITIES,
        note: `Could not reach ${redact(url)}. Check the URL, that the server is running, and that it accepts this origin.`,
      })
    }
    ws.onclose = (ev) => {
      // A close during the listen window is still evidence: report the code,
      // which is how a rejected key shows up (1008/4401).
      finish({ ...NO_CAPABILITIES, note: `${redact(url)} closed the connection${closeDetail(ev)}.` })
    }
  })
}

// ── Provider ─────────────────────────────────────────────────────────────────

export class WebSocketWorldProvider implements WorldModelProvider {
  readonly id = 'websocket' as const
  readonly label = 'WebSocket endpoint'
  private cfg: WebSocketWorldConfig

  constructor(cfg: WebSocketWorldConfig) {
    this.cfg = cfg
  }

  isConfigured(): boolean {
    return resolveEndpoint(this.cfg).url !== null
  }

  async probe(signal?: AbortSignal | undefined): Promise<WorldCapabilities> {
    const endpoint = resolveEndpoint(this.cfg)
    if (!endpoint.url) return { ...NO_CAPABILITIES, note: endpoint.error }
    return probeEndpoint(endpoint, this.cfg, signal)
  }

  async connect(options: WorldConnectOptions): Promise<WorldSession> {
    const endpoint = resolveEndpoint(this.cfg)
    if (!endpoint.url) throw new WorldProviderError(endpoint.error ?? 'WebSocket endpoint is not configured')
    const session = new WebSocketWorldSession(endpoint, this.cfg, options)
    try {
      await session.open()
    } catch (e) {
      // Failing to connect must not leave a half-open socket behind.
      await session.dispose()
      throw e instanceof WorldProviderError ? e : new WorldProviderError(errText(e))
    }
    // A refused key ends the session inside the handshake window. Returning that
    // corpse would hand the UI a player that can never draw and never explain
    // itself; the caller wants the reason, as an error, now.
    const terminal = session.terminalReason
    if (terminal) {
      await session.dispose()
      throw new WorldProviderError(terminal)
    }
    return session
  }
}

export function createWebSocketWorldProvider(cfg: WebSocketWorldConfig): WorldModelProvider {
  return new WebSocketWorldProvider(cfg)
}
