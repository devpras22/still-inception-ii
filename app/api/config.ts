/**
 * GET /api/config — is this a deployed demo, and with what world-model key?
 *
 * The Reactor session is opened BY THE BROWSER (WebRTC to api.reactor.inc),
 * so its key must reach the client. It is served here at runtime from the
 * Vercel environment — never baked into the bundle, never in the repo. It is
 * still visible to anyone who opens devtools on the deployed link; that is
 * inherent to a browser-side world model and the reason every key used by
 * this demo should be rotated after the hackathon.
 */
import type { DemoRequest, DemoResponse } from './types'

export default function config(req: DemoRequest, res: DemoResponse): void {
  if (req.method !== 'GET') { res.status(405).json({ detail: 'GET only' }); return }
  const reactorKey = (process.env['REACTOR_API_KEY'] ?? '').trim()
  res.status(200).json({ deployed: reactorKey.length > 0, ...(reactorKey ? { reactorKey } : {}) })
}
