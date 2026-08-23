/**
 * STILL — the door is the photograph itself. Pickups point straight at their
 * memory STATES (the live world booted from the same picture the player is
 * holding), the clip cutscenes are gone (a clip rendered its own version of
 * the scene — the zoom ended on one image and a lookalike session started on
 * another), and each memory speaks one continuous line: the memory, then the
 * present tense.
 *
 *   npx tsx scripts/fix-door.ts
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { fileStore, defaultStorePath } from '../../alakazam-studio/src/world/store/file.node'
import { LocalWorldStore } from '../../alakazam-studio/src/world/store/local'

const HERE = dirname(fileURLToPath(import.meta.url))
const SPEC = JSON.parse(readFileSync(join(HERE, '..', 'spec', 'story.json'), 'utf8')) as {
  name: string
  logline: string
  memories: { id: string; voice: string; in_world: string }[]
}
const WORLD_ID = readFileSync(join(HERE, '..', 'spec', 'world-id.txt'), 'utf8').trim()

async function main(): Promise<void> {
  const store = new LocalWorldStore(fileStore(defaultStorePath()))
  const scene = await store.getScene(WORLD_ID)
  const rev = scene.rev
  const ops: Record<string, unknown>[] = []

  for (const mem of SPEC.memories) {
    ops.push({ op: 'update_event', name: `pickup_${mem.id}`, to: mem.id })
    ops.push({
      op: 'update_state', id: mem.id,
      narration: `${mem.voice} ${mem.in_world}`,
    })
    ops.push({ op: 'remove_cutscene', id: `cut_${mem.id}` })
  }

  const result = await store.applyOps(WORLD_ID, ops, rev)
  console.log(`${ops.length} ops → rev ${result.rev}`)
  for (const d of result.diagnostics ?? []) console.log(`  [${d.severity}] ${d.lint}: ${d.message}`)

  const file = defaultStorePath()
  const outer = JSON.parse(readFileSync(file, 'utf8')) as Record<string, string>
  const db = JSON.parse(outer['alakazam-studio:worlds:v1']) as { worlds: { id: string; world: Record<string, unknown> }[] }
  const mine = db.worlds.find((w) => w.id === WORLD_ID)
  if (!mine) throw new Error('world vanished from store')
  mine.world['tagline'] = SPEC.logline.split('. ').slice(0, 2).join('. ') + '.'
  outer['alakazam-studio:worlds:v1'] = JSON.stringify(db)
  writeFileSync(file, JSON.stringify(outer))
  console.log('tagline written')

  const verdict = await store.validate(WORLD_ID)
  const linted = await store.lint(WORLD_ID)
  console.log(`validate: ${verdict.ok ? 'OK' : 'FAILED'} · lint: ${linted.ok ? 'OK' : 'FAILED'}`)
  for (const d of [...verdict.diagnostics, ...linted.diagnostics]) console.log(`  [${d.severity}] ${d.lint}: ${d.message}`)
  if (!verdict.ok || !linted.ok) process.exit(1)
}

void main().catch((e: unknown) => { console.error(String(e)); process.exit(1) })
