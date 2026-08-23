/**
 * THE SUITE SPEAKS — one line of prose, one audio clip, played and forgotten.
 *
 * Two voices, in order of preference:
 *   1. the storage bridge's /voice — Fish Audio's TTS, called server-side so
 *      the key never touches the browser. Hackathon-partner voice, noir by
 *      default.
 *   2. the studio's active OpenAI-compatible endpoint's /audio/speech — the
 *      fallback that needs no bridge, used only when the first voice fails.
 *
 * Text-to-speech is polish, not plumbing: a failed voice call must never take
 * a reply off the screen, so every failure here is silent to the player (loud
 * in the console) and `speak` always resolves. One Audio element is reused so
 * a new line cuts off the previous one: a suite that talks over itself is a
 * haunting, not a narrator.
 */
import { llmEndpoint } from '../provider/registry'
import type { ProviderConfig } from '../provider/types'

const TTS_MODEL = 'gpt-4o-mini-tts'
/** Low, worn, unhurried — the fallback voice of a room that has seen a thing or two. */
const TTS_VOICE = 'onyx'

let current: HTMLAudioElement | null = null

function bridgeBase(cfg: ProviderConfig): string {
  return cfg.world.alakazam.apiBase.replace(/\/+$/, '')
}

export function voiceAvailable(cfg: ProviderConfig): boolean {
  if (bridgeBase(cfg).length > 0) return true
  const ep = llmEndpoint(cfg, cfg.llm.active)
  return ep.baseUrl.includes('api.openai.com') && ep.apiKey.trim().length > 0
}

async function playBlob(blob: Blob): Promise<void> {
  const url = URL.createObjectURL(blob)
  if (current) { current.pause(); current.src = '' }
  current = new Audio(url)
  // The voice is the point — full volume, everything else ducks around it.
  current.volume = 1
  await current.play().catch(() => {})
  window.setTimeout(() => URL.revokeObjectURL(url), 120_000)
}

async function speakViaBridge(cfg: ProviderConfig, line: string, fishVoice?: string): Promise<boolean> {
  const base = bridgeBase(cfg)
  if (!base) return false
  try {
    const res = await fetch(`${base}/voice`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: line, ...(fishVoice ? { reference_id: fishVoice } : {}) }),
    })
    if (!res.ok) {
      console.warn(`[voice] bridge /voice → HTTP ${res.status}`, (await res.text()).slice(0, 160))
      return false
    }
    await playBlob(await res.blob())
    return true
  } catch (e) {
    console.warn('[voice] bridge unreachable —', e instanceof Error ? e.message : String(e))
    return false
  }
}

async function speakViaOpenAI(
  cfg: ProviderConfig,
  line: string,
  voice?: string,
  instructions?: string,
): Promise<void> {
  const ep = llmEndpoint(cfg, cfg.llm.active)
  if (!ep.baseUrl.includes('api.openai.com') || !ep.apiKey.trim()) return
  try {
    const res = await fetch(`${ep.baseUrl}/audio/speech`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${ep.apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: TTS_MODEL,
        voice: voice ?? TTS_VOICE,
        input: line,
        response_format: 'mp3',
        ...(instructions ? { instructions } : {}),
      }),
    })
    if (!res.ok) {
      // Silent to the PLAYER, loud to the developer: a swallowed 401 here is
      // why a room can mysteriously lose its voice.
      console.warn(`[voice] ${ep.baseUrl}/audio/speech → HTTP ${res.status}`, (await res.text()).slice(0, 200))
      return
    }
    await playBlob(await res.blob())
  } catch {
    /* the line is already on screen; the voice is a bonus */
  }
}

/** A character's voice: which TTS voice, how it is DELIVERED, whether the
 *  partner voice is skipped because this part is cast, not defaulted — and the
 *  Fish reference_id when the part is played by a designed Fish voice. */
export interface VoicePart {
  voice?: string
  instructions?: string
  cast?: boolean
  fishVoice?: string
}

export async function speak(text: string, cfg: ProviderConfig, part?: VoicePart): Promise<void> {
  const line = text.trim()
  if (!line) return
  if (!part?.cast) {
    if (await speakViaBridge(cfg, line, part?.fishVoice)) return
  }
  await speakViaOpenAI(cfg, line, part?.voice, part?.instructions)
}
