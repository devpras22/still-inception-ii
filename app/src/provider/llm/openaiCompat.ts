/**
 * One adapter for every OpenAI-shaped endpoint.
 *
 * Cerebras, Groq, OpenAI, OpenRouter, Ollama, LM Studio, vLLM, llama.cpp and most
 * company gateways all accept `POST {baseUrl}/chat/completions` with the same
 * body, so there is no reason for a second adapter or for an SDK per vendor. What
 * differs between them is which optional fields they tolerate — and that is
 * handled below by asking for the useful ones and repairing the request when the
 * server says no, instead of shipping a per-vendor capability table that would be
 * wrong within a month.
 *
 * THIS RUNS IN A BROWSER, which is the constraint that shapes the error messages.
 * A page can only reach an endpoint that answers cross-origin requests with CORS
 * headers. Preflighted from a localhost origin on 2026-07-30, api.openai.com,
 * api.groq.com, api.cerebras.ai and openrouter.ai all return
 * `access-control-allow-origin`, so the hosted presets work from the page as-is.
 * The local servers do not by default: Ollama only allows origins listed in
 * OLLAMA_ORIGINS (read at process start), and LM Studio has an "Enable CORS"
 * switch. A user who hits a CORS wall is looking at their server's policy, not a
 * bug in the studio, and the message they get says exactly that.
 *
 * Keys reach this file from Settings → localStorage only. Never from a VITE_ env
 * var: those are inlined into the bundle at build time, so a key put there is
 * published to every visitor rather than configured.
 */

import { LLMError, type LLMMessage, type LLMProvider, type LLMRequest } from '../types'

export interface OpenAICompatConfig {
  /** Preset id; surfaces as LLMProvider.id so the UI can key off it. */
  id: string
  label: string
  baseUrl: string
  /** May be empty — local servers ignore auth entirely. */
  apiKey: string
  model: string
  /** False for endpoints that need no key, so isConfigured() does not lie. */
  keyRequired?: boolean
}

/** Initial attempt plus at most three repairs (see the degrade ladder below). */
const MAX_ATTEMPTS = 4

/**
 * Used only after `response_format` has been dropped. Once the server has refused
 * to *enforce* JSON, asking for it in words is the only remaining lever, and the
 * contract says a provider that cannot enforce JSON must still try.
 */
const JSON_NUDGE: LLMMessage = {
  role: 'system',
  content: 'Reply with a single JSON object and nothing else — no prose, no markdown fences.',
}

const LOOPBACK = /^https?:\/\/(localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\])(:|\/|$)/i

/**
 * Accept both spellings of the endpoint. People paste the URL they were told to
 * POST to, and silently turning that into /chat/completions/chat/completions is a
 * 404 with no explanation in it.
 */
function normalizeBaseUrl(raw: string): string {
  return raw
    .trim()
    .replace(/\/+$/, '')
    .replace(/\/chat\/completions$/i, '')
}

/** The one shape check every reader below builds on: an object, not an array,
 *  not null — everything past that is read field-by-field and re-checked. */
function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

/** Pull the human sentence out of the several error envelopes in the wild. */
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
  // Truncated: an HTML error page is worth a hint, not a wall of markup.
  return body.length > 300 ? `${body.slice(0, 300)}…` : body
}

function firstChoice(payload: unknown): Record<string, unknown> | null {
  if (!isRecord(payload)) return null
  const choices = payload["choices"]
  if (!Array.isArray(choices) || choices.length === 0) return null
  const choice = choices[0]
  return isRecord(choice) ? choice : null
}

/** null = the response was not shaped like a chat completion at all. */
function extractContent(payload: unknown): string | null {
  const choice = firstChoice(payload)
  if (!choice) return null
  const message = choice["message"]
  const content = isRecord(message) ? message["content"] : undefined
  if (typeof content === 'string') return content
  // Some servers return content as parts rather than a string.
  if (Array.isArray(content)) {
    return content
      .map((part) => {
        if (typeof part === 'string') return part
        const t = isRecord(part) ? part["text"] : undefined
        return typeof t === 'string' ? t : ''
      })
      .join('')
  }
  // Legacy /completions-shaped servers put the text on the choice itself.
  const text = choice["text"]
  if (typeof text === 'string') return text
  // A real completion whose content is null is NOT "not a chat completion". A
  // reasoning model that exhausts its budget before writing an answer returns
  // exactly this — choices[0].message.content === null with
  // finish_reason "length" — and reporting it as a malformed endpoint sent the
  // user off to check a base URL that was correct. Hand back '' so the caller
  // reaches the empty-reply branch, which already names the real cause.
  if (content === null || content === undefined) return ''
  return null
}

function isAbort(e: unknown): boolean {
  return isRecord(e) && e["name"] === 'AbortError'
}

export class OpenAICompatProvider implements LLMProvider {
  readonly id: string
  readonly label: string
  readonly baseUrl: string
  private readonly apiKey: string
  private readonly model: string
  private readonly keyRequired: boolean

  constructor(cfg: OpenAICompatConfig) {
    this.id = cfg.id
    this.label = cfg.label
    this.baseUrl = normalizeBaseUrl(cfg.baseUrl)
    this.apiKey = cfg.apiKey.trim()
    this.model = cfg.model.trim()
    this.keyRequired = cfg.keyRequired ?? true
  }

  isConfigured(): boolean {
    if (!this.baseUrl || !this.model) return false
    return this.keyRequired ? this.apiKey.length > 0 : true
  }

  async complete(req: LLMRequest): Promise<string> {
    const model = (req.model || this.model).trim()
    if (!this.baseUrl) throw new LLMError(`${this.label} has no base URL — set one in Settings.`)
    if (!model) throw new LLMError(`no model selected for ${this.label} — pick one in Settings.`)
    // Cheaper to say this than to spend a round trip earning a 401.
    if (this.keyRequired && !this.apiKey) throw new LLMError(`${this.label} needs an API key — add one in Settings.`, 401)

    const url = `${this.baseUrl}/chat/completions`

    // The degrade ladder. Every rung is a field some OpenAI-compatible server
    // rejects while its neighbours require it, and none of them is worth losing
    // the user's edit over:
    //   response_format  — unsupported on plenty of gateways and older servers
    //   max_tokens       — the GPT-5 family rejects it and wants max_completion_tokens,
    //                      while Ollama/vLLM/Groq only know max_tokens
    //   temperature      — some reasoning models accept the default and nothing else
    // We send the portable spelling first and rename or drop only when the server
    // names the field in its 400, so a working request never pays for this.
    let sendJson = req.json === true
    let sendTemperature = req.temperature !== undefined
    let tokenField: 'max_tokens' | 'max_completion_tokens' = 'max_tokens'
    const repaired = { json: false, tokens: false, temperature: false }

    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      const askedForJsonButCannotEnforceIt = req.json === true && !sendJson
      const body: Record<string, unknown> = {
        model,
        messages: askedForJsonButCannotEnforceIt ? [JSON_NUDGE, ...req.messages] : req.messages,
        stream: false,
      }
      if (sendTemperature) body["temperature"] = req.temperature
      if (req.maxTokens !== undefined) body[tokenField] = req.maxTokens
      if (sendJson) body["response_format"] = { type: 'json_object' }

      const res = await this.request('POST', url, body, req.signal)
      if (res.ok) return this.readReply(res.json)

      const detail = errorDetail(res.text)
      // 422 is included because several self-hosted servers use it for the same
      // "I do not know that field" that OpenAI reports as 400.
      if ((res.status === 400 || res.status === 422) && attempt < MAX_ATTEMPTS) {
        // Dropped on ANY 400, not only on one that names response_format: servers
        // word this refusal a dozen different ways ("unsupported parameter",
        // "json mode not available", a bare "invalid request"), and pattern-matching
        // the wording would fail the user's edit on the ones we guessed wrong. A
        // false positive costs one extra request and still surfaces the real error.
        if (sendJson && !repaired.json) {
          repaired.json = true
          sendJson = false
          continue
        }
        if (
          !repaired.tokens &&
          req.maxTokens !== undefined &&
          tokenField === 'max_tokens' &&
          /max_tokens|max_completion_tokens/i.test(detail)
        ) {
          repaired.tokens = true
          tokenField = 'max_completion_tokens'
          continue
        }
        if (sendTemperature && !repaired.temperature && /temperature/i.test(detail)) {
          repaired.temperature = true
          sendTemperature = false
          continue
        }
      }
      throw this.httpError(res.status, detail, url, model)
    }

    // Unreachable: every path above either returns or throws.
    throw new LLMError(`${this.label} rejected the request repeatedly.`)
  }

  /** Populates the model dropdown. Not every endpoint has /models; throwing is fine. */
  async listModels(signal?: AbortSignal | undefined): Promise<string[]> {
    if (!this.baseUrl) throw new LLMError(`${this.label} has no base URL — set one in Settings.`)
    const url = `${this.baseUrl}/models`
    const res = await this.request('GET', url, undefined, signal)
    if (!res.ok) {
      if (res.status === 404) throw new LLMError(`${this.label} does not list models at ${url} — type the model id by hand.`, 404)
      throw this.httpError(res.status, errorDetail(res.text), url, this.model)
    }
    // {data:[…]} is the OpenAI shape; a bare array turns up on hand-rolled servers.
    const payload = res.json
    const raw = Array.isArray(payload) ? payload : isRecord(payload) ? payload["data"] : undefined
    const ids = (Array.isArray(raw) ? raw : [])
      .map((m) => {
        if (typeof m === 'string') return m
        const id = isRecord(m) ? m["id"] : undefined
        return typeof id === 'string' ? id : ''
      })
      .filter((id) => id.length > 0)
    return [...new Set(ids)].sort((a, b) => a.localeCompare(b))
  }

  private readReply(payload: unknown): string {
    const content = extractContent(payload)
    if (content === null) {
      throw new LLMError(`${this.label} answered with something that is not a chat completion — check that the base URL points at an OpenAI-compatible API.`)
    }
    if (content.trim() === '') {
      // Returning '' would surface downstream as an unexplained JSON parse failure,
      // so name the two things that actually cause it.
      const reason = firstChoice(payload)?.["finish_reason"]
      throw new LLMError(
        reason === 'length'
          ? `${this.label} hit the token limit before writing anything — raise max tokens, or pick a model that does not spend the whole budget on reasoning.`
          : `${this.label} returned an empty reply.`,
      )
    }
    return content
  }

  private headers(withBody: boolean): Record<string, string> {
    const h: Record<string, string> = {}
    if (withBody) h['Content-Type'] = 'application/json'
    // An empty Bearer is worse than no header: gateways that would have served an
    // anonymous request answer 401 to a malformed credential, which sends the user
    // hunting for a key their local server never wanted.
    if (this.apiKey) h["Authorization"] = `Bearer ${this.apiKey}`
    return h
  }

  private async request(
    method: 'GET' | 'POST',
    url: string,
    body: unknown,
    signal?: AbortSignal | undefined,
  ): Promise<{ ok: boolean; status: number; json: unknown; text: string }> {
    let res: Response
    try {
      res = await fetch(url, {
        method,
        headers: this.headers(body !== undefined),
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        ...(signal ? { signal } : {}),
      })
    } catch (e) {
      // An abort is the caller changing its mind, not a failure worth a message —
      // rethrow it untouched so callers can keep matching on AbortError.
      if (isAbort(e)) throw e
      throw this.networkError(e)
    }
    let text: string
    try {
      text = await res.text()
    } catch (e) {
      if (isAbort(e)) throw e
      throw this.networkError(e)
    }
    let json: unknown
    try {
      json = text ? JSON.parse(text) : undefined
    } catch {
      json = undefined
    }
    return { ok: res.ok, status: res.status, json, text }
  }

  /**
   * fetch() rejects with the same opaque TypeError whether the host is down, DNS
   * failed, or the browser dropped a perfectly good response for want of CORS
   * headers — the spec deliberately hides which. So the message has to cover all
   * three, and lead with the one the user can act on.
   */
  private networkError(e: unknown): LLMError {
    const cause = (e instanceof Error && e.message) || String(e)
    if (LOOPBACK.test(this.baseUrl)) {
      return new LLMError(
        `Could not reach ${this.label} at ${this.baseUrl} (${cause}). Check the server is running, then check it allows this page's origin: Ollama needs OLLAMA_ORIGINS="*" (or this exact origin) set before it starts, and LM Studio needs "Enable CORS" under Developer → Server Settings. Serving the studio over https while the model server is plain http is also blocked by some browsers — run the studio from http://localhost too.`,
        0,
      )
    }
    return new LLMError(
      `Could not reach ${this.label} at ${this.baseUrl} (${cause}). Either the network failed or the endpoint refused a browser origin — an API that returns no CORS headers cannot be called from a page at all, which is that endpoint's policy rather than a fault in the studio. Use the vendor's documented base URL, or put a proxy that adds CORS headers in front of it.`,
      0,
    )
  }

  private httpError(status: number, detail: string, url: string, model: string): LLMError {
    const tail = detail ? ` — ${detail}` : ''
    if (status === 401) return new LLMError(`key rejected by ${this.label}${tail}. Check the API key in Settings.`, 401)
    if (status === 403) {
      return new LLMError(`key rejected by ${this.label} (403 — the key is valid but not allowed here)${tail}. Check the key's scopes and whether your account has access to "${model}".`, 403)
    }
    if (status === 404) {
      // Two unrelated faults share this status. Ollama and most gateways name the
      // model in the body when that is what is missing; otherwise the path is wrong.
      if (/model/i.test(detail)) {
        return new LLMError(`${this.label} has no model "${model}"${tail}. Pick one from the model list, or pull/load it on the server.`, 404)
      }
      return new LLMError(`this endpoint has no /chat/completions — check the base URL (${url}). Most OpenAI-compatible servers want it to end in /v1.`, 404)
    }
    if (status === 429) return new LLMError(`${this.label} rate-limited this request or you are out of credit (429)${tail}. Wait a moment, or check the account's plan.`, 429)
    if (status === 400 || status === 422) return new LLMError(`${this.label} rejected the request${tail}`, status)
    if (status >= 500) return new LLMError(`${this.label} failed on its own side (HTTP ${status})${tail}. Retry, or try another model.`, status)
    return new LLMError(`${this.label} returned HTTP ${status}${tail}`, status)
  }
}

/** Convenience for the config layer: one preset + one saved endpoint → a provider. */
export function createOpenAICompatProvider(cfg: OpenAICompatConfig): LLMProvider {
  return new OpenAICompatProvider(cfg)
}
