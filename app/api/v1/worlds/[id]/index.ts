/** GET /api/v1/worlds/:id — the world record (getWorld). */
import type { DemoRequest, DemoResponse } from '../../../types'
import worldDoc from '../../world-data'

const doc: Record<string, unknown> = worldDoc

export default function world(req: DemoRequest, res: DemoResponse): void {
  const id = decodeURIComponent(new URL(req.url ?? '/', 'https://x').pathname.split('/').filter(Boolean)[3] ?? '')
  if (id !== doc['id']) { res.status(404).json({ detail: `no such world: ${id}` }); return }
  res.status(200).json(doc)
}
