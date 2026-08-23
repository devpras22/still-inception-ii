/**
 * POST /api/voice — Ellen's voice, fish.audio, key stays server-side.
 *
 * Ported from the local dev bridge (room9/store-server.ts) unchanged in
 * substance: {text, reference_id?} in, audio/mpeg out. The client is the
 * studio's speakViaBridge; the fish key never touches the browser.
 */
import type { DemoRequest, DemoResponse } from './types'

export default async function voice(req: DemoRequest, res: DemoResponse): Promise<void> {
  if (req.method !== 'POST') { res.status(405).json({ detail: 'POST only' }); return }
  const key = (process.env['FISH_AUDIO_API_KEY'] ?? '').trim()
  if (!key) { res.status(503).json({ detail: 'voice not configured' }); return }
  const body = (req.body ?? {}) as { text?: unknown; reference_id?: unknown }
  const text = typeof body.text === 'string' ? body.text : ''
  const referenceId = typeof body.reference_id === 'string' ? body.reference_id : undefined
  if (!text.trim()) { res.status(400).json({ detail: 'text required' }); return }

  try {
    const fishRes = await fetch('https://api.fish.audio/v1/tts', {
      method: 'POST',
      headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        text, format: 'mp3', normalize: true, latency: 'normal',
        ...(referenceId ? { reference_id: referenceId } : {}),
      }),
    })
    if (!fishRes.ok) {
      const detail = (await fishRes.text()).slice(0, 200)
      console.error(`/api/voice: fish.audio HTTP ${fishRes.status} — ${detail}`)
      res.status(502).json({ detail: `fish.audio HTTP ${fishRes.status}` })
      return
    }
    const audio = Buffer.from(await fishRes.arrayBuffer())
    res.setHeader('Content-Type', 'audio/mpeg')
    res.setHeader('Content-Length', audio.length)
    res.status(200).end(audio)
  } catch (e) {
    console.error('/api/voice:', e instanceof Error ? e.message : String(e))
    res.status(502).json({ detail: 'voice upstream unreachable' })
  }
}
