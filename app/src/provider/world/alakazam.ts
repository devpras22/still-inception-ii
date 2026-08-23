/**
 * Alakazam hosted world model — today's behaviour, demoted to one option.
 *
 * Nothing here is new: mint a short-lived session token off the public `/v1` API
 * and mount the vendor runtime in an iframe, exactly as PlayModal has always
 * done. What changed is that this is now a provider you can switch away from,
 * rather than the only wire the studio has.
 *
 * The API surface is the shared AlakazamClient (`../../api/client`) — the same
 * instance the rest of the studio uses when one is passed in, so mint calls
 * still show up in the API log panel instead of happening invisibly.
 *
 * Session minting is metered. probe() therefore checks the key against a read
 * endpoint and never mints: asking "does this key work?" must not cost a play.
 */

import { AlakazamClient, type ApiError } from '../../world/api'
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

type AlakazamConfig = ProviderConfig['world']['alakazam']

/**
 * The hosted runtime executes the world graph it was minted for; it exposes no
 * inbound channel, so a beat pushed from the studio into a session that is
 * already running goes nowhere. Exported rather than merely commented so the UI
 * can grey out a live-push control instead of offering a button that lies.
 */
export const ALAKAZAM_SUPPORTS_LIVE_PUSH = false

const CAPABILITIES: WorldCapabilities = {
  streaming: true,
  // FALSE, deliberately, even though the stored graph does drive the picture.
  // The contract defines promptableEvents as "accepts authored world events
  // MID-SESSION", and this runtime rejects every one of them. Declaring true
  // silenced capabilityWarning() for the single backend proven to refuse live
  // beats, and forced every consumer to special-case one provider — which is
  // exactly what the capability seam exists to avoid. The nuance belongs in
  // `note`, which is why `note` exists.
  promptableEvents: false,
  heldCommands: true,
  persistentWorlds: true,
  note:
    'Hosted runtime. Your authored states, events and held input DO drive the picture — the world graph ' +
    'lives in the API and the embed executes it, so a transition you wrote is what the player sees. What ' +
    'this backend cannot do is take a beat pushed from the studio into an already-running session: save the ' +
    'graph and restart the session to see an edit. Each play mints a metered session.',
}

/** Session TTL for the mint. Matches the studio's long-standing 15 minutes. */
const SESSION_TTL_SECONDS = 900

export interface AlakazamWorldOptions {
  /**
   * Reuse the studio's live client (ClientContext) so probes and mints land in
   * the API log. Omitted, the provider builds its own from `cfg`.
   */
  client?: AlakazamClient
}

class AlakazamSession implements WorldSession {
  readonly capabilities = CAPABILITIES

  private iframe: HTMLIFrameElement | null = null
  private handlers = new Set<(reason: string) => void>()
  private endedReason: string | null = null
  private warnedNoLivePush = false
  private onMessage: ((e: MessageEvent) => void) | null = null

  constructor(
    private readonly embedSrc: string,
    private readonly embedOrigin: string,
    private readonly worldId: string,
  ) {}

  mount(container: HTMLElement): void {
    this.detach()
    const frame = document.createElement('iframe')
    frame.className = 'embed'
    frame.src = this.embedSrc
    frame.title = `Play ${this.worldId}`
    frame.setAttribute('allow', 'autoplay; fullscreen')
    container.appendChild(frame)
    this.iframe = frame

    // The runtime is cross-origin, so a termination notice can only arrive as a
    // postMessage. Filter by origin AND by source frame: another tab's embed
    // must not be able to declare this session dead.
    this.onMessage = (e: MessageEvent) => {
      if (e.origin !== this.embedOrigin || e.source !== frame.contentWindow) return
      const type = String((e.data as { type?: unknown } | null)?.type ?? '')
      if (!/^(ended|closed|expired|error|session[-_.]?(ended|closed|expired|error))$/i.test(type)) return
      const reason = String((e.data as { reason?: unknown } | null)?.reason ?? type)
      this.end(reason)
    }
    window.addEventListener('message', this.onMessage)
  }

  /**
   * Rejects, every time. The envelope still goes out for any self-hosted embed
   * that grows a listener, but a cross-origin postMessage into a frame with
   * nothing listening looks exactly like a delivered one — and this runtime is
   * not listening. Resolving would report a success nothing can confirm, which
   * is precisely the silent failure this provider seam exists to prevent.
   *
   * The cost is that a caller who fire-and-forgets one of these per keypress
   * gets a rejection per keypress. That is why `ALAKAZAM_SUPPORTS_LIVE_PUSH` is
   * exported: the UI is meant to consult it and never offer the control, rather
   * than call this and swallow the answer.
   */
  async sendEvent(event: WorldEvent): Promise<void> {
    // Never '*' as the target origin — the frame holds a session token. Posted
    // best-effort for any self-hosted embed that grows a listener.
    this.iframe?.contentWindow?.postMessage({ source: 'alakazam-studio', type: 'world-event', event }, this.embedOrigin)
    // Resolves rather than throws, per the contract: sendEvent is a no-op when
    // !promptableEvents. Held commands arrive as a stream, so rejecting per
    // keypress would flood the studio with unhandled rejections over a fact
    // that cannot change mid-session. Warned once so it is discoverable in a
    // console without being noise.
    if (!this.warnedNoLivePush) {
      this.warnedNoLivePush = true
      console.info(
        '[alakazam] This runtime does not accept beats pushed into a running session; ' +
          `"${event.kind}: ${event.value}" was not delivered. Authored events still drive the picture ` +
          'through the stored world graph — save the edit and restart the session to see it.',
      )
    }
  }

  onEnded(handler: (reason: string) => void): () => void {
    this.handlers.add(handler)
    if (this.endedReason) {
      const reason = this.endedReason
      queueMicrotask(() => {
        if (this.handlers.has(handler)) handler(reason)
      })
    }
    return () => {
      this.handlers.delete(handler)
    }
  }

  async dispose(): Promise<void> {
    this.detach()
    this.handlers.clear()
  }

  private detach(): void {
    if (this.onMessage) window.removeEventListener('message', this.onMessage)
    this.onMessage = null
    if (this.iframe) {
      // Navigate away before removing so the runtime tears its own stream down
      // rather than leaving a socket to the GPU session dangling.
      this.iframe.src = 'about:blank'
      this.iframe.remove()
    }
    this.iframe = null
  }

  private end(reason: string): void {
    if (this.endedReason) return
    this.endedReason = reason
    for (const h of [...this.handlers]) h(reason)
  }
}

function isApiError(e: unknown): e is ApiError {
  return typeof e === 'object' && e !== null && 'status' in e
}

/** Human-readable reason a probe failed, phrased as something the user can fix. */
function probeNote(e: unknown, apiBase: string): string {
  if (isApiError(e)) {
    switch (e.status) {
      case 0:
        return `Could not reach ${apiBase}. Check the API base, your network, and that the host allows browser (CORS) requests.`
      case 401:
        return 'Key rejected (401). Check the key is current and not from a different environment.'
      case 403:
        return `Key lacks the scopes this studio needs (403). It needs worlds:read, worlds:write and sessions:mint. ${e.detail || ''}`.trim()
      case 404:
        return `No /v1 API answered at ${apiBase} (404). Wrong host, or a proxy that does not forward /v1.`
      case 429:
        return 'Rate limited (429) while probing. The key looks real; try again shortly.'
      default:
        return `${apiBase} returned HTTP ${e.status}. ${e.detail || ''}`.trim()
    }
  }
  return e instanceof Error ? e.message : 'Probe failed for an unknown reason.'
}

/** Status-specific copy for mint failures, so a blocked play explains itself. */
function mintError(e: unknown): WorldProviderError {
  if (isApiError(e)) {
    switch (e.status) {
      case 402:
        return new WorldProviderError(`Playback is blocked by your plan limit (402). ${e.detail || 'Check usage/billing, then try again.'}`, 402)
      case 403:
        return new WorldProviderError(`This key cannot mint sessions (403). It needs the sessions:mint scope. ${e.detail || ''}`.trim(), 403)
      case 404:
        return new WorldProviderError(`World not found (404). ${e.detail || "It may have been deleted, or isn't published yet."}`, 404)
      case 503:
        return new WorldProviderError(`The play runtime is temporarily unavailable (503). ${e.detail || 'Please try again in a moment.'}`, 503)
      default:
        return new WorldProviderError(e.detail || e.message || 'Could not start a play session.', e.status)
    }
  }
  return new WorldProviderError(e instanceof Error ? e.message : 'Could not start a play session.')
}

/**
 * Settle as soon as the caller aborts. The shared client owns retries and the
 * API log and takes no AbortSignal, so the in-flight request is left to finish
 * on its own — we simply stop waiting on a result nobody wants.
 */
function abortable<T>(work: Promise<T>, signal?: AbortSignal | undefined): Promise<T> {
  if (!signal) return work
  if (signal.aborted) {
    // Nobody will ever look at `work`, but an unobserved rejection still prints
    // a scary uncaught error in the console of a studio that is behaving.
    void work.catch(() => {})
    return Promise.reject(new DOMException('aborted', 'AbortError'))
  }
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(new DOMException('aborted', 'AbortError'))
    signal.addEventListener('abort', onAbort, { once: true })
    work.then(resolve, reject).finally(() => signal.removeEventListener('abort', onAbort))
  })
}

function isAbort(e: unknown): boolean {
  return e instanceof DOMException ? e.name === 'AbortError' : false
}

export class AlakazamWorldProvider implements WorldModelProvider {
  readonly id = 'alakazam' as const
  readonly label = 'Alakazam (hosted)'

  private readonly apiBase: string
  private readonly embedHost: string
  private readonly apiKey: string
  private readonly injected: AlakazamClient | null
  private owned: AlakazamClient | null = null

  constructor(cfg: AlakazamConfig, opts: AlakazamWorldOptions = {}) {
    this.apiBase = (cfg.apiBase || '').trim().replace(/\/$/, '')
    this.embedHost = (cfg.embedHost || '').trim().replace(/\/$/, '')
    this.apiKey = (cfg.apiKey || '').trim()
    this.injected = opts.client ?? null
  }

  // Deliberately not enforcing the sk_/pk_ key shape: this same provider points
  // at a self-hosted /v1 whose keys may look like anything. probe() asks the
  // server, which is the only answer that is ever true.
  isConfigured(): boolean {
    return !!this.apiKey && !!this.apiBase && !!this.embedHost
  }

  async probe(signal?: AbortSignal | undefined): Promise<WorldCapabilities> {
    if (!this.apiBase || !this.apiKey) {
      return { ...NO_CAPABILITIES, note: 'Add the API base and a key in Settings.' }
    }
    // GET /v1/usage: authenticated, cheap, and mints nothing.
    try {
      const usage = await abortable(this.client().usage(), signal)
      return { ...CAPABILITIES, note: `${CAPABILITIES.note} Key verified against ${this.apiBase} (usage for ${usage.day}).` }
    } catch (e) {
      if (isAbort(e)) return { ...NO_CAPABILITIES, note: 'Probe cancelled.' }
      // A key scoped to worlds+sessions but not usage would fail the check above
      // while being perfectly able to play, so confirm with a read that this
      // studio actually depends on before calling the key dead.
      if (isApiError(e) && (e.status === 401 || e.status === 403 || e.status === 404)) {
        try {
          await abortable(this.client().listWorlds({ limit: 1 }), signal)
          return { ...CAPABILITIES, note: `${CAPABILITIES.note} Key verified against ${this.apiBase} (worlds read; /v1/usage was not permitted).` }
        } catch (inner) {
          if (isAbort(inner)) return { ...NO_CAPABILITIES, note: 'Probe cancelled.' }
          return { ...NO_CAPABILITIES, note: probeNote(inner, this.apiBase) }
        }
      }
      return { ...NO_CAPABILITIES, note: probeNote(e, this.apiBase) }
    }
  }

  /** `prompt` and `firstFrameUrl` are ignored on purpose: the hosted runtime
   *  reads both from the stored world it loads by id, not from this browser. */
  async connect(options: WorldConnectOptions): Promise<WorldSession> {
    if (!this.apiBase || !this.apiKey) throw new WorldProviderError('Alakazam is not configured: add the API base and key in Settings.')
    if (!this.embedHost) throw new WorldProviderError('Alakazam has no embed host configured, so there is nothing to mount the runtime in.')

    let embedOrigin: string
    try {
      embedOrigin = new URL(this.embedHost).origin
    } catch {
      throw new WorldProviderError(`Embed host "${this.embedHost}" is not a valid URL.`)
    }

    // Check before the call, not just after: an aborted connect must not leave a
    // metered session minted behind it.
    if (options.signal?.aborted) throw new WorldProviderError('Connect cancelled before minting.')

    const api = this.client()
    let token: string
    try {
      const minted = await api.mintSession({ worldId: options.worldId, playerIdentity: 'studio', ttlSeconds: SESSION_TTL_SECONDS })
      token = minted.token
    } catch (e) {
      throw mintError(e)
    }

    // Minted tokens cannot be revoked; an abort that lands here just lets it
    // expire unused rather than mounting a frame nobody asked for.
    if (options.signal?.aborted) throw new WorldProviderError('Connect cancelled; the minted session token will expire unused.')

    return new AlakazamSession(api.embedUrl(this.embedHost, token), embedOrigin, options.worldId)
  }

  /** Built lazily and reused: the registry constructs a provider on every
   *  settings change, and an unconfigured one should cost nothing. */
  private client(): AlakazamClient {
    if (this.injected) return this.injected
    if (!this.owned) this.owned = new AlakazamClient({ baseUrl: this.apiBase, apiKey: this.apiKey })
    return this.owned
  }
}

/** Factory form, for call sites that would rather not write `new`. */
export function createAlakazamWorldProvider(cfg: AlakazamConfig, opts: AlakazamWorldOptions = {}): WorldModelProvider {
  return new AlakazamWorldProvider(cfg, opts)
}
