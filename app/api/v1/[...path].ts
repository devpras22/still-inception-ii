/**
 * The world API the deployed player reads — one catch-all serving the static
 * still-world.json written by still/scripts/slim-world.ts:
 *
 *   GET  /api/v1/worlds                  → list (My Creations)
 *   GET  /api/v1/worlds/:id              → the world record (getWorld)
 *   GET  /api/v1/worlds/:id/scene        → {states, events, rev} (getScene)
 *   POST /api/v1/worlds/:id/validate|lint → the verdict the authoring store
 *                                          already gave this rev
 *
 * Player treats validate/lint failures as non-fatal; an unknown id 404s and
 * the player says so. Writes are not served: the deployed demo is a cinema,
 * not an editor.
 */
import type { DemoRequest, DemoResponse } from '../types'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'

let cached: Record<string, unknown> | null = null
async function world(): Promise<Record<string, unknown>> {
  if (!cached) {
    const raw = await readFile(join(process.cwd(), 'public', 'still-world.json'), 'utf8')
    cached = JSON.parse(raw) as Record<string, unknown>
  }
  return cached
}

function json(res: DemoResponse, status: number, body: unknown): void {
  res.status(status).json(body)
}

export default async function handler(req: DemoRequest, res: DemoResponse): Promise<void> {
  // /api/v1/<seg>/<...> — the Vercel catch-all param arrives on req.query,
  // but url parsing needs no Vercel types.
  const path = (req.url ?? '').split('?')[0] ?? '/'
  const segs = path.split('/').filter(Boolean).slice(2) // drop api/v1
  try {
    const doc = await world()

    if (req.method === 'GET' && segs[0] === 'worlds' && segs.length === 1) {
      json(res, 200, {
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
      return
    }

    if (segs[0] === 'worlds' && segs.length >= 2) {
      const id = decodeURIComponent(segs[1] ?? '')
      if (id !== doc['id']) { json(res, 404, { detail: `no such world: ${id}` }); return }

      if (req.method === 'GET' && segs.length === 2) { json(res, 200, doc); return }
      if (req.method === 'GET' && segs[2] === 'scene') {
        const scene = doc['scene'] as { states: unknown; events: unknown }
        json(res, 200, { states: scene.states, events: scene.events, rev: 'still-demo' })
        return
      }
      if (req.method === 'POST' && (segs[2] === 'validate' || segs[2] === 'lint')) {
        // The authoring store validated this exact rev before shipping (every
        // still/scripts/* push runs validate+lint). Serving the verdict rather
        // than re-running the doctrine keeps the demo stateless.
        json(res, 200, { ok: true, diagnostics: [] })
        return
      }
    }

    json(res, 404, { detail: `not part of the demo API: ${req.method} ${req.url}` })
  } catch (e) {
    console.error('/api/v1:', e instanceof Error ? e.message : String(e))
    json(res, 500, { detail: 'world record unreadable' })
  }
}
