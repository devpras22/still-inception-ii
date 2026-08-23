/**
 * STILL — calmer world prompts (a world model holds a still scene with one
 * gentle motion far better than a choreographed shot list) and the improv
 * flag: the homecoming lines are written live by the configured LLM from what
 * the player has actually seen, with the authored lines as fallback.
 *
 *   npx tsx scripts/fix-prompts.ts
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { fileStore, defaultStorePath } from '../../alakazam-studio/src/world/store/file.node'
import { LocalWorldStore } from '../../alakazam-studio/src/world/store/local'

const HERE = dirname(fileURLToPath(import.meta.url))
const SPEC = JSON.parse(readFileSync(join(HERE, '..', 'spec', 'story.json'), 'utf8')) as {
  memories: { id: string; alive_prompt: string }[]
}
const WORLD_ID = readFileSync(join(HERE, '..', 'spec', 'world-id.txt'), 'utf8').trim()
const CAMERA = ' Wide establishing view, eye level. Photorealistic, cinematic 35mm.'

async function main(): Promise<void> {
  const store = new LocalWorldStore(fileStore(defaultStorePath()))
  const rev = (await store.getScene(WORLD_ID)).rev
  const ops: Record<string, unknown>[] = []
  for (const mem of SPEC.memories) {
    ops.push({ op: 'update_state', id: mem.id, base: mem.alive_prompt + CAMERA })
    ops.push({ op: 'update_event', name: `pickup_${mem.id}`, base: mem.alive_prompt + CAMERA })
  }
  const result = await store.applyOps(WORLD_ID, ops, rev)
  console.log(`${ops.length} ops → rev ${result.rev}`)
  for (const d of result.diagnostics ?? []) console.log(`  [${d.severity}] ${d.lint}: ${d.message}`)

  const file = defaultStorePath()
  const outer = JSON.parse(readFileSync(file, 'utf8')) as Record<string, string>
  const db = JSON.parse(outer['alakazam-studio:worlds:v1']) as { worlds: { id: string; world: Record<string, unknown> }[] }
  const mine = db.worlds.find((w) => w.id === WORLD_ID)
  if (!mine) throw new Error('world vanished from store')
  mine.world['improviseReturns'] = true
  outer['alakazam-studio:worlds:v1'] = JSON.stringify(db)
  writeFileSync(file, JSON.stringify(outer))
  console.log('improviseReturns written')

  const verdict = await store.validate(WORLD_ID)
  const linted = await store.lint(WORLD_ID)
  console.log(`validate: ${verdict.ok ? 'OK' : 'FAILED'} · lint: ${linted.ok ? 'OK' : 'FAILED'}`)
  if (!verdict.ok || !linted.ok) process.exit(1)
}

void main().catch((e: unknown) => { console.error(String(e)); process.exit(1) })
