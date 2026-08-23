/**
 * POST /api/llm/chat/completions — the improvised homecoming lines.
 *
 * A transparent OpenAI-compatible proxy: the studio's LLM provider is pointed
 * at /api/llm as its baseUrl, calls /chat/completions exactly as it would
 * api.openai.com, and this function swaps the placeholder auth for the real
 * key held in the Vercel environment. The browser never sees an OpenAI key.
 */
import type { DemoRequest, DemoResponse } from '../../types'

export default async function completions(req: DemoRequest, res: DemoResponse): Promise<void> {
  if (req.method !== 'POST') { res.status(405).json({ detail: 'POST only' }); return }
  const key = (process.env['OPENAI_API_KEY'] ?? '').trim()
  if (!key) { res.status(503).json({ detail: 'llm not configured' }); return }

  try {
    const upstream = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(req.body),
    })
    const body = await upstream.text()
    res.setHeader('Content-Type', upstream.headers.get('content-type') ?? 'application/json')
    res.status(upstream.status).end(body)
  } catch (e) {
    console.error('/api/llm:', e instanceof Error ? e.message : String(e))
    res.status(502).json({ detail: 'llm upstream unreachable' })
  }
}
