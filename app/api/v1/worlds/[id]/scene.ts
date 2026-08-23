/** GET /api/v1/worlds/:id/scene — {states, events, rev} (getScene). */
import type { DemoRequest, DemoResponse } from '../../../types'
import worldDoc from '../../world-data'

const doc: Record<string, unknown> = worldDoc

export default function scene(req: DemoRequest, res: DemoResponse): void {
  const id = decodeURIComponent(new URL(req.url ?? '/', 'https://x').pathname.split('/').filter(Boolean)[3] ?? '')
  if (id !== doc['id']) { res.status(404).json({ detail: `no such world: ${id}` }); return }
  const scene = doc['scene'] as { states: unknown; events: unknown }
  res.status(200).json({ states: scene.states, events: scene.events, rev: 'still-demo' })
}
