/**
 * Endpoint presets for bring-your-own-LLM.
 *
 * Every entry here speaks the same wire format — POST {baseUrl}/chat/completions
 * in OpenAI's shape — which is why one adapter (openaiCompat.ts) covers all of
 * them and a preset is nothing but pre-filled text. `custom` exists because this
 * list can never be complete: vLLM, llama.cpp, TGI, LiteLLM, Together, DeepSeek
 * and most company gateways speak the same shape.
 *
 * The base URLs and model ids below were read off each vendor's own docs on
 * 2026-07-30 rather than recalled, because getting one wrong costs the user a
 * confusing 404 on their first call. They still rot: `listModels()` on the
 * adapter is the live truth, and `defaultModel` is only a first guess so the
 * studio can make a call before anyone has opened a dropdown.
 *
 * BROWSER REACHABILITY. The studio calls these endpoints from a page, so an
 * endpoint that does not return CORS headers is unreachable no matter how valid
 * the key is. Preflighted from a localhost origin on 2026-07-30: OpenAI, Groq,
 * Cerebras and OpenRouter all answered with `access-control-allow-origin`. The
 * two local servers do not, out of the box — hence `corsHint`, which Settings
 * should show up front rather than leaving the user to decode a red console.
 */


export interface LLMPreset {
  /** Also the key into ProviderConfig.llm.endpoints and the LLMProvider id. */
  id: string
  label: string
  /** No trailing slash — the adapter appends /chat/completions and /models. */
  baseUrl: string
  /** First guess only; replaced by whatever the endpoint's /models reports. */
  defaultModel: string
  /** False where the server ignores auth entirely, so the UI can stop nagging. */
  keyRequired: boolean
  /** Where a human goes to get a key, or to install the server for local ones. */
  docsUrl: string
  /** Runs on the user's own machine: no key, no bill, but CORS is their problem. */
  local?: boolean
  /** Shown next to the endpoint fields when the browser is likely to block it. */
  corsHint?: string
  /** One line of orientation in Settings. */
  note?: string
}

export const CUSTOM_PRESET_ID = 'custom'

/**
 * The default is a keyless local server on purpose: the studio's promise is that
 * it works with no account, and Ollama is the shortest path from "cloned the
 * repo" to "the agent edits my graph". Anyone with a hosted key switches in one
 * click, and the adapter's error text names the fix when Ollama is not running.
 */
export const DEFAULT_LLM_PRESET_ID = 'ollama'

export const LLM_PRESETS: readonly LLMPreset[] = [
  {
    id: 'cerebras',
    label: 'Cerebras',
    baseUrl: 'https://api.cerebras.ai/v1',
    defaultModel: 'gpt-oss-120b',
    keyRequired: true,
    docsUrl: 'https://cloud.cerebras.ai',
    note: 'Free trial tier on signup. Their docs list gpt-oss-120b as the production model.',
  },
  {
    id: 'groq',
    label: 'Groq',
    baseUrl: 'https://api.groq.com/openai/v1',
    defaultModel: 'llama-3.3-70b-versatile',
    keyRequired: true,
    docsUrl: 'https://console.groq.com/keys',
    note: 'Free developer tier with rate limits. Production model ids are listed at console.groq.com/docs/models.',
  },
  {
    id: 'openai',
    label: 'OpenAI',
    baseUrl: 'https://api.openai.com/v1',
    defaultModel: 'gpt-5.6-luna',
    keyRequired: true,
    docsUrl: 'https://platform.openai.com/api-keys',
    note: 'Pay as you go. gpt-5.6-luna is the cost-optimised tier; any chat model id works.',
  },
  {
    id: 'openrouter',
    label: 'OpenRouter',
    baseUrl: 'https://openrouter.ai/api/v1',
    defaultModel: 'openai/gpt-5.6-luna',
    keyRequired: true,
    docsUrl: 'https://openrouter.ai/keys',
    note: 'One key, many vendors — model ids carry a vendor prefix (openai/…, anthropic/…, qwen/…). openrouter/auto picks for you.',
  },
  {
    id: 'ollama',
    label: 'Ollama',
    baseUrl: 'http://localhost:11434/v1',
    defaultModel: 'llama3.2',
    keyRequired: false,
    local: true,
    docsUrl: 'https://docs.ollama.com/api/openai-compatibility',
    note: 'Runs on your machine. No key, no bill; the model list is whatever you have pulled.',
    corsHint:
      'Ollama rejects browser origins it was not told about. Start it with OLLAMA_ORIGINS="*" (or this page\'s exact origin) — the variable is read at startup, so restart Ollama after setting it.',
  },
  {
    id: 'lmstudio',
    label: 'LM Studio',
    baseUrl: 'http://localhost:1234/v1',
    defaultModel: 'qwen2.5-7b-instruct',
    keyRequired: false,
    local: true,
    docsUrl: 'https://lmstudio.ai/docs/developer/openai-compat',
    note: 'Runs on your machine. Start the local server from the Developer tab; model ids are whatever you have downloaded.',
    corsHint: 'If the browser blocks the call, switch on "Enable CORS" in LM Studio under Developer → Server Settings.',
  },
  {
    id: CUSTOM_PRESET_ID,
    label: 'Custom (OpenAI-compatible)',
    baseUrl: '',
    defaultModel: '',
    // Unknowable up front: a self-hosted vLLM usually takes any key, a company
    // gateway usually demands one. Left false so the UI never blocks a working
    // keyless endpoint; the endpoint's own 401 is the honest gate.
    keyRequired: false,
    docsUrl: 'https://developers.openai.com/api/docs/api-reference/chat',
    note: 'Anything that answers POST /chat/completions: vLLM, llama.cpp, TGI, LiteLLM, DeepSeek, a gateway of your own.',
    corsHint: 'A browser can only reach an endpoint that returns CORS headers for this page\'s origin.',
  },
]

export function getPreset(id: string): LLMPreset | undefined {
  return LLM_PRESETS.find((p) => p.id === id)
}

