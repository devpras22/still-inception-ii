/**
 * Gemini image generation ("Nano Banana") — paint YOUR seed frame.
 *
 * One adapter, one vendor: POST {model}:generateContent on Google's
 * generativelanguage API, asking for an IMAGE part back. This is what Create's
 * "Paint a seed frame" button calls when a Gemini key is configured; without
 * one, Create falls back to the hosted seed-frame path.
 *
 * THE KEY LIVES IN THIS BROWSER'S localStorage and is sent to Google's
 * generativelanguage API and NOWHERE ELSE — same doctrine as every other key
 * in this studio (see Settings → "Where your keys go").
 */

import { ImageError, type ImageProvider } from '../types'

export interface GeminiImageConfig {
  /** May be empty — isConfigured() is false until one is set. */
  apiKey: string
  model: string
}

/** "Nano Banana Pro". Used whenever the saved model is blank. */
export const DEFAULT_GEMINI_IMAGE_MODEL = 'gemini-3-pro-image'

const API_ROOT = 'https://generativelanguage.googleapis.com/v1beta/models'

/** The one shape check every reader below builds on, same idiom as
 *  llm/openaiCompat.ts: an object, not an array, not null. */
function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

function isAbort(e: unknown): boolean {
  return isRecord(e) && e["name"] === 'AbortError'
}

/** Pull the human sentence out of Google's `{error:{message}}` envelope. */
function errorDetail(text: string): string {
  const body = text.trim()
  if (!body) return ''
  try {
    const j: unknown = JSON.parse(body)
    if (isRecord(j)) {
      const error = j["error"]
      if (isRecord(error) && typeof error["message"] === 'string') return error["message"]
    }
  } catch {
    /* not JSON — a proxy or a stray HTML page; fall through to the raw body */
  }
  return body.length > 300 ? `${body.slice(0, 300)}…` : body
}

/** One `content.parts[]` entry → the inline image it carries, or null. */
function inlineImage(part: unknown): { b64: string; mime: string } | null {
  if (!isRecord(part)) return null
  const inline = part["inlineData"]
  if (!isRecord(inline)) return null
  const data = inline["data"]
  const mime = inline["mimeType"]
  if (typeof data !== 'string' || typeof mime !== 'string') return null
  return { b64: data, mime }
}

/** candidates[0].content.parts[] → the first part carrying an image. */
function findImage(payload: unknown): { b64: string; mime: string } | null {
  if (!isRecord(payload)) return null
  const candidates = payload["candidates"]
  if (!Array.isArray(candidates) || candidates.length === 0) return null
  const first = candidates[0]
  const content = isRecord(first) ? first["content"] : undefined
  const parts = isRecord(content) ? content["parts"] : undefined
  if (!Array.isArray(parts)) return null
  for (const part of parts) {
    const img = inlineImage(part)
    if (img) return img
  }
  return null
}

function candidateFinishReason(payload: unknown): string | undefined {
  if (!isRecord(payload)) return undefined
  const candidates = payload["candidates"]
  const first = Array.isArray(candidates) ? candidates[0] : undefined
  const reason = isRecord(first) ? first["finishReason"] : undefined
  return typeof reason === 'string' ? reason : undefined
}

function promptBlockReason(payload: unknown): string | undefined {
  if (!isRecord(payload)) return undefined
  const feedback = payload["promptFeedback"]
  const reason = isRecord(feedback) ? feedback["blockReason"] : undefined
  return typeof reason === 'string' ? reason : undefined
}

export class GeminiImageProvider implements ImageProvider {
  readonly id = 'gemini' as const
  readonly label = 'Gemini'
  private readonly apiKey: string
  private readonly model: string

  constructor(cfg: GeminiImageConfig) {
    this.apiKey = cfg.apiKey.trim()
    this.model = cfg.model.trim() || DEFAULT_GEMINI_IMAGE_MODEL
  }

  isConfigured(): boolean {
    return this.apiKey.length > 0
  }

  async generate(prompt: string, signal?: AbortSignal | undefined): Promise<{ b64: string; mime: string }> {
    if (!this.apiKey) throw new ImageError(`${this.label} needs an API key — add one in Settings (Seed images).`, 401)

    const url = `${API_ROOT}/${this.model}:generateContent`
    const body = {
      contents: [{ parts: [{ text: prompt }] }],
      generationConfig: { responseModalities: ['IMAGE'], imageConfig: { aspectRatio: '16:9' } },
    }

    let res: Response
    try {
      res = await fetch(url, {
        method: 'POST',
        headers: { 'x-goog-api-key': this.apiKey, 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        ...(signal ? { signal } : {}),
      })
    } catch (e) {
      if (isAbort(e)) throw e
      const cause = e instanceof Error ? e.message : String(e)
      throw new ImageError(`could not reach ${this.label} (${cause}). Check your network connection.`, 0)
    }

    let text: string
    try {
      text = await res.text()
    } catch (e) {
      if (isAbort(e)) throw e
      const cause = e instanceof Error ? e.message : String(e)
      throw new ImageError(`could not read ${this.label}'s response (${cause}).`, 0)
    }

    if (!res.ok) {
      const detail = errorDetail(text)
      const tail = detail ? ` — ${detail}` : ''
      if (res.status === 400 || res.status === 401 || res.status === 403) {
        throw new ImageError(`${this.label} rejected the key (HTTP ${res.status})${tail}. Copy it again from Google AI Studio.`, res.status)
      }
      if (res.status === 429) {
        throw new ImageError(`${this.label} rate-limited this request${tail}. Wait a moment and try again.`, 429)
      }
      throw new ImageError(`${this.label} returned HTTP ${res.status}${tail}`, res.status)
    }

    let json: unknown
    try {
      json = text ? JSON.parse(text) : undefined
    } catch {
      json = undefined
    }

    const image = findImage(json)
    if (image) return image

    // No image part. Surface the API's own reason rather than a flat "it
    // failed" — a blocked prompt and an exhausted model look identical from
    // the outside otherwise.
    const blocked = promptBlockReason(json)
    if (blocked) throw new ImageError(`${this.label} blocked the request: ${blocked}.`)
    const reason = candidateFinishReason(json)
    if (reason && reason !== 'STOP') throw new ImageError(`${this.label} stopped before returning an image: ${reason}.`)
    throw new ImageError('the model answered without an image.')
  }
}

export function createGeminiImageProvider(cfg: GeminiImageConfig): ImageProvider {
  return new GeminiImageProvider(cfg)
}
