/**
 * Moondream detect — ground a world's clickable objects in what a detector can
 * actually see.
 *
 * TWO ENDPOINTS, one provider, chosen by config — the same shape the LLM axis
 * already uses for "cloud preset vs. local Ollama/LM Studio":
 *   · cloud   POST https://api.moondream.ai/v1/detect with the user's own key.
 *   · local   POST to a self-hosted Moondream Station (or anything else that
 *             speaks the same /v1/detect shape), no key at all. This is the
 *             honest OSS answer: the whole point of this repo is that you can
 *             run it yourself.
 *
 * Request/response shape is pinned to Moondream's actual /v1/detect contract,
 * NOT guessed: `{image_url, object, stream:false}` in,
 * `{objects:[{x_min,y_min,x_max,y_max,...}]}` out, already 0..1 normalised —
 * no /1000 rescale needed on this side. `image_url` also accepts a `data:` URL
 * directly, so a browser frame never needs an extra signed-URL round trip.
 *
 * THE KEY LIVES IN THIS BROWSER'S localStorage and is sent to api.moondream.ai
 * and NOWHERE ELSE — same doctrine as every other key in this studio (see
 * Settings → "Where your keys go").
 */

import { VisionError, type DetectedBox, type VisionProvider } from '../types'

export interface MoondreamVisionConfig {
  endpoint: 'cloud' | 'local'
  /** May be empty — only read when endpoint is 'cloud'. */
  apiKey: string
  /** May be empty — only read when endpoint is 'local'. */
  localUrl: string
}

/** Moondream Station's default port. Shown as the local-URL field's placeholder
 *  in Settings, never silently substituted for a blank saved value — a blank
 *  localUrl means "not configured", not "assume localhost", so the keyless
 *  promise holds even for a loopback address nobody asked this page to call. */
export const DEFAULT_MOONDREAM_LOCAL_URL = 'http://localhost:2020/v1/detect'

const CLOUD_DETECT_URL = 'https://api.moondream.ai/v1/detect'

/** The one shape check every reader below builds on, same idiom as
 *  llm/openaiCompat.ts and image/gemini.ts: an object, not an array, not null. */
function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

function isAbort(e: unknown): boolean {
  return isRecord(e) && e["name"] === 'AbortError'
}

/** Pull the human sentence out of whichever error envelope the server used. */
function errorDetail(text: string): string {
  const body = text.trim()
  if (!body) return ''
  try {
    const j: unknown = JSON.parse(body)
    if (isRecord(j)) {
      const error = j["error"]
      if (typeof error === 'string') return error
      if (isRecord(error) && typeof error["message"] === 'string') return error["message"]
      if (typeof j["message"] === 'string') return j["message"]
      if (typeof j["detail"] === 'string') return j["detail"]
    }
  } catch {
    /* not JSON — a proxy or a stray HTML page; fall through to the raw body */
  }
  return body.length > 300 ? `${body.slice(0, 300)}…` : body
}

/**
 * One `objects[]` entry → a normalised box, or null when it isn't structurally
 * one — a missing/non-numeric coordinate, or a degenerate zero/negative-area
 * box. Dropping the bad entry (rather than failing the whole call) means a
 * detector fanning out several boxes per query does not lose every good one
 * because one entry came back odd. Clamped to the unit square because the API
 * contract says 0..1 but nothing stops a stray value from arriving outside it.
 */
function toBox(v: unknown): DetectedBox | null {
  if (!isRecord(v)) return null
  const xMin = v["x_min"]
  const yMin = v["y_min"]
  const xMax = v["x_max"]
  const yMax = v["y_max"]
  if (typeof xMin !== 'number' || typeof yMin !== 'number' || typeof xMax !== 'number' || typeof yMax !== 'number') {
    return null
  }
  if (!Number.isFinite(xMin) || !Number.isFinite(yMin) || !Number.isFinite(xMax) || !Number.isFinite(yMax)) return null
  if (xMax <= xMin || yMax <= yMin) return null
  const clamp = (n: number) => Math.max(0, Math.min(1, n))
  return { xMin: clamp(xMin), yMin: clamp(yMin), xMax: clamp(xMax), yMax: clamp(yMax) }
}

export class MoondreamVisionProvider implements VisionProvider {
  readonly id = 'moondream'
  readonly label = 'Moondream'
  private readonly endpoint: 'cloud' | 'local'
  private readonly apiKey: string
  private readonly localUrl: string

  constructor(cfg: MoondreamVisionConfig) {
    this.endpoint = cfg.endpoint
    this.apiKey = cfg.apiKey.trim()
    this.localUrl = cfg.localUrl.trim()
  }

  isConfigured(): boolean {
    return this.endpoint === 'cloud' ? this.apiKey.length > 0 : this.localUrl.length > 0
  }

  async detect(imageB64: string, object: string, signal?: AbortSignal | undefined): Promise<DetectedBox[]> {
    const query = object.trim()
    if (!query) throw new VisionError('no object given to detect — pass a plain noun like "door" or "lantern".')

    let url: string
    if (this.endpoint === 'cloud') {
      if (!this.apiKey) throw new VisionError(`${this.label} needs an API key — add one in Settings (Vision).`, 401)
      url = CLOUD_DETECT_URL
    } else {
      if (!this.localUrl) throw new VisionError('no local Moondream URL configured — add one in Settings (Vision), or point it at Moondream Station.')
      url = this.localUrl
    }

    // Moondream's /v1/detect wants `image_url` (a string) and accepts `data:`
    // URLs directly — prepend the prefix only when it's missing:
    // double-prefixing produces a 422 ("Could not load image from url:").
    const imageUrl = imageB64.startsWith('data:') ? imageB64 : `data:image/jpeg;base64,${imageB64}`
    const body = { image_url: imageUrl, object: query, stream: false }
    const headers: Record<string, string> = { 'Content-Type': 'application/json' }
    if (this.endpoint === 'cloud') headers['Authorization'] = `Bearer ${this.apiKey}`

    let res: Response
    try {
      res = await fetch(url, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
        ...(signal ? { signal } : {}),
      })
    } catch (e) {
      if (isAbort(e)) throw e
      const cause = e instanceof Error ? e.message : String(e)
      if (this.endpoint === 'local') {
        throw new VisionError(
          `could not reach ${url} (${cause}). Moondream Station may not be running — start it, or point the local URL in Settings (Vision) at wherever it's actually serving.`,
          0,
        )
      }
      throw new VisionError(`could not reach ${this.label} (${cause}). Check your network connection.`, 0)
    }

    let text: string
    try {
      text = await res.text()
    } catch (e) {
      if (isAbort(e)) throw e
      const cause = e instanceof Error ? e.message : String(e)
      throw new VisionError(`could not read ${this.label}'s response (${cause}).`, 0)
    }

    if (!res.ok) {
      const detail = errorDetail(text)
      const tail = detail ? ` — ${detail}` : ''
      if (res.status === 401 || res.status === 403) {
        throw new VisionError(`${this.label} rejected the key (HTTP ${res.status})${tail}. Copy it again from moondream.ai.`, res.status)
      }
      if (res.status === 429) {
        throw new VisionError(`${this.label} rate-limited this request${tail}. Wait a moment and try again.`, 429)
      }
      throw new VisionError(`${this.label} returned HTTP ${res.status}${tail}`, res.status)
    }

    let json: unknown
    try {
      json = text ? JSON.parse(text) : undefined
    } catch {
      json = undefined
    }

    // Narrow the response STRUCTURALLY rather than trusting it: a server that
    // answers 200 with an unrelated JSON body (a proxy's own error envelope, a
    // health-check page someone pointed the local URL at) must not come back
    // as "zero objects detected" — that reads as a clean miss instead of the
    // misconfiguration it actually is.
    if (!isRecord(json)) {
      throw new VisionError(`${this.label} returned a response that is not a JSON object — check the endpoint is actually a Moondream /v1/detect server.`)
    }
    const objects = json["objects"]
    if (!Array.isArray(objects)) {
      throw new VisionError(`${this.label} returned a response with no "objects" list — check the endpoint is actually a Moondream /v1/detect server.`)
    }

    const boxes: DetectedBox[] = []
    for (const o of objects) {
      const box = toBox(o)
      if (box) boxes.push(box)
    }
    return boxes
  }
}

export function createMoondreamVisionProvider(cfg: MoondreamVisionConfig): VisionProvider {
  return new MoondreamVisionProvider(cfg)
}
