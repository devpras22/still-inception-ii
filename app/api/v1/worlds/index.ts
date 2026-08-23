/** GET /api/v1/worlds — the list behind "My Creations". */
import type { DemoRequest, DemoResponse } from '../../types'
import worldDoc from '../world-data'

const doc: Record<string, unknown> = worldDoc

export default function list(_req: DemoRequest, res: DemoResponse): void {
  res.status(200).json({
    worlds: [{
      id: doc['id'],
      name: doc['name'],
      description: doc['description'],
      cover: doc['cover'],
      visibility: 'private',
      updated_at: new Date().toISOString(),
    }],
    nextCursor: null,
  })
}
