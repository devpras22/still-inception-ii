/**
 * Provider contracts — the seam that makes this studio yours.
 *
 * The studio used to be a thin client of one hosted API: play minted a token
 * from that API and mounted that vendor's runtime, and every LLM call was
 * proxied through the same place. Useful as a product, useless as something you
 * self-host, because none of it worked without an account you could not create.
 *
 * There are three independent axes, and you can mix them freely:
 *
 *   WorldModelProvider — what draws the world and reacts to it.
 *     · reactor    your own Reactor key, straight to their API
 *     · websocket  any WebSocket endpoint speaking the protocol below
 *     · alakazam   the hosted path, unchanged, for people who want it
 *     · mock       no key, no network, canned frames — the default so the
 *                  studio is usable before you have signed up for anything
 *
 *   LLMProvider — what writes and edits worlds.
 *     · any OpenAI-compatible /chat/completions endpoint: Cerebras, Groq,
 *       OpenAI, OpenRouter, Ollama, LM Studio, vLLM, or your own.
 *
 *   ImageProvider — what paints a seed frame to anchor a new world.
 *     · gemini     your own Gemini key, straight to Google's
 *                  generativelanguage API ("Nano Banana")
 *     · absent a key here, Create falls back to the hosted seed-frame path
 *       when an Alakazam key is configured, else painting is off.
 *
 *   VisionProvider — what grounds a world's clickable objects in what a
 *   detector can actually see.
 *     · moondream, cloud endpoint    your own Moondream key, straight to
 *                                    api.moondream.ai
 *     · moondream, local endpoint    a self-hosted Moondream Station (or any
 *                                    server speaking its /v1/detect shape),
 *                                    no key at all — the honest OSS answer
 *
 * CAPABILITIES ARE NOT COSMETIC. A world model that streams frames is not
 * necessarily a world model that responds to your authored events. If you point
 * the studio at a backend that only streams, your state prompts and transitions
 * will run, the HUD will update, and the picture will ignore all of it. That is
 * a confusing hour for anyone who has not been told, so a provider must declare
 * `promptableEvents` and the studio must warn loudly when it is false.
 */

// ─── World model ─────────────────────────────────────────────────────────────

/** What a backend can actually do. Probed once at connect time, never assumed. */
export interface WorldCapabilities {
  /** Produces video frames at all. False means the provider is inert (mock/offline). */
  streaming: boolean
  /**
   * Accepts authored world events mid-session — the thing that makes a
   * state machine visible. When false the studio shows a standing warning:
   * transitions still fire, the picture just will not follow them.
   */
  promptableEvents: boolean
  /** Accepts held movement/look input (WASD-style driving). */
  heldCommands: boolean
  /** Can create a persistent world that later sessions can re-enter by id. */
  persistentWorlds: boolean
  /** Free-text note shown next to the capability row, e.g. why something is off. */
  note?: string | undefined
}

export const NO_CAPABILITIES: WorldCapabilities = {
  streaming: false,
  promptableEvents: false,
  heldCommands: false,
  persistentWorlds: false,
}

/**
 * An authored beat pushed into a live world.
 *
 * WHICH CAPABILITY GATES WHICH KIND — providers disagreed on this and shipped
 * opposite rules, so it is settled here:
 *   `prompt` / `state`  → gated by `promptableEvents` (authored prose)
 *   `command`           → gated by `heldCommands`     (player-style input)
 * A provider that can take movement but not prose is a real thing, and folding
 * both into one flag made it unrepresentable. sendEvent() no-ops (resolved) when
 * the relevant capability is false; it never throws for that reason alone.
 */
export interface WorldEvent {
  kind: 'prompt' | 'state' | 'command'
  /** Prose for `prompt`/`state`; a command token (e.g. "Front") for `command`. */
  value: string
  /** Optional state id this event belongs to, for provider-side bookkeeping. */
  stateId?: string | undefined
}

/** A live session. Created by connect(); owns exactly one mount point. */
export interface WorldSession {
  readonly capabilities: WorldCapabilities
  /** Render into this element. Providers mount an <iframe> or a <video>. */
  mount(container: HTMLElement): void | Promise<void>
  /** Push an authored beat. No-ops (resolved) when the gating capability for
   *  that kind is false — see WorldEvent for which flag gates which kind. */
  sendEvent(event: WorldEvent): Promise<void>
  /** Fires on provider-side termination so the UI can stop pretending it is live. */
  onEnded(handler: (reason: string) => void): () => void
  /** Tear down: stop the stream, close sockets, release the GPU session. */
  dispose(): Promise<void>
}

export interface WorldConnectOptions {
  /** The world being played, as the studio knows it. */
  worldId: string
  /** Opening prompt / scene description, when the backend takes one. */
  prompt?: string | undefined
  /** Publicly reachable first-frame image, when the backend takes one. */
  firstFrameUrl?: string | undefined
  signal?: AbortSignal | undefined
}

export interface WorldModelProvider {
  readonly id: 'reactor' | 'websocket' | 'alakazam' | 'mock'
  readonly label: string
  /** True when the user has supplied whatever this provider needs to run. */
  isConfigured(): boolean
  /**
   * Ask the backend what it can do, WITHOUT starting a billable session where
   * that is avoidable. Must never throw: a failed probe returns
   * NO_CAPABILITIES with `note` explaining why, so the UI can show the reason.
   */
  probe(signal?: AbortSignal | undefined): Promise<WorldCapabilities>
  connect(options: WorldConnectOptions): Promise<WorldSession>
}

// ─── LLM ─────────────────────────────────────────────────────────────────────

export interface LLMMessage {
  role: 'system' | 'user' | 'assistant'
  content: string
}

export interface LLMRequest {
  messages: LLMMessage[]
  /** Overrides the provider's configured default. */
  model?: string | undefined
  temperature?: number | undefined
  maxTokens?: number | undefined
  /** Ask for a JSON object back. Providers that cannot enforce it must still try. */
  json?: boolean | undefined
  signal?: AbortSignal | undefined
}

export interface LLMProvider {
  readonly id: string
  readonly label: string
  isConfigured(): boolean
  /** Returns the assistant text. Throws LLMError with a human-readable message. */
  complete(req: LLMRequest): Promise<string>
  /** Optional: populate a model dropdown. Absent or throwing is fine. */
  listModels?(signal?: AbortSignal | undefined): Promise<string[]>
}

export class LLMError extends Error {
  constructor(message: string, readonly status?: number) {
    super(message)
    this.name = 'LLMError'
  }
}

// ─── Image ───────────────────────────────────────────────────────────────────

export interface ImageProvider {
  readonly id: string
  readonly label: string
  isConfigured(): boolean
  /** Paints one image from a text prompt. Throws ImageError with a
   *  human-readable message on failure. */
  generate(prompt: string, signal?: AbortSignal | undefined): Promise<{ b64: string; mime: string }>
}

export class ImageError extends Error {
  constructor(message: string, readonly status?: number) {
    super(message)
    this.name = 'ImageError'
  }
}

export class WorldProviderError extends Error {
  constructor(message: string, readonly status?: number) {
    super(message)
    this.name = 'WorldProviderError'
  }
}

// ─── Vision ──────────────────────────────────────────────────────────────────

/**
 * One detected instance of an open-vocabulary object query, 0..1 normalised
 * against the frame it was measured on — the same convention every box in this
 * studio uses regardless of which detector produced it.
 */
export interface DetectedBox {
  xMin: number
  yMin: number
  xMax: number
  yMax: number
}

export interface VisionProvider {
  readonly id: string
  readonly label: string
  isConfigured(): boolean
  /** Open-vocabulary detect: find every instance of one plain noun in one frame. */
  detect(imageB64: string, object: string, signal?: AbortSignal | undefined): Promise<DetectedBox[]>
}

export class VisionError extends Error {
  constructor(message: string, readonly status?: number) {
    super(message)
    this.name = 'VisionError'
  }
}

// ─── Configuration ───────────────────────────────────────────────────────────

/**
 * Everything the user can set. Persisted to localStorage, NEVER to a VITE_ env
 * var — those are compiled into the bundle and served to every visitor, so a key
 * placed there is published rather than configured.
 */
export interface ProviderConfig {
  world: {
    active: WorldModelProvider['id']
    reactor: { apiKey: string; mode: 'adventure' | 'directing' }
    /** Any endpoint speaking the WS protocol in providers/world/websocket.ts. */
    websocket: { url: string; apiKey: string; protocol: 'auto' | 'alakazam-ws' | 'raw' }
    alakazam: { apiBase: string; embedHost: string; apiKey: string }
  }
  llm: {
    active: string
    /** Keyed by preset id; `custom` is user-entered. */
    endpoints: Record<string, { baseUrl: string; apiKey: string; model: string }>
  }
  image: {
    /** Sent as the x-goog-api-key header, straight to Google. Never proxied. */
    geminiKey: string
    model: string
  }
  vision: {
    /** Which /v1/detect this axis calls. Local is the default so a fresh clone
     *  never depends on anyone's cloud account. */
    endpoint: 'cloud' | 'local'
    /** Sent as an `Authorization: Bearer` header to Moondream Cloud ONLY —
     *  the local endpoint takes no key. */
    apiKey: string
    /** A self-hosted Moondream Station (or compatible) /v1/detect address,
     *  e.g. http://localhost:2020/v1/detect. Blank until the user sets one —
     *  see moondream.ts's DEFAULT_MOONDREAM_LOCAL_URL for the suggested value
     *  shown as the field's placeholder. */
    localUrl: string
  }
}
