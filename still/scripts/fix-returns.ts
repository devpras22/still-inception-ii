/**
 * STILL — what the sessions are actually told, and what Ellen says when you
 * come home. The pickup events were still carrying the LIVING ROOM prompt as
 * their base (the original wiring), and the event's prompt outranks the
 * state's at reseed — so every memory session booted from the right seed
 * image while being steered toward a room with a shoebox (the bike memory
 * grew a photograph box). Pickups now carry their own memory's prompt, and
 * every put-it-back speaks its own line.
 *
 *   npx tsx scripts/fix-returns.ts
 */
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { fileStore, defaultStorePath } from '../../alakazam-studio/src/world/store/file.node'
import { LocalWorldStore } from '../../alakazam-studio/src/world/store/local'

const HERE = dirname(fileURLToPath(import.meta.url))
const SPEC = JSON.parse(readFileSync(join(HERE, '..', 'spec', 'story.json'), 'utf8')) as {
  memories: { id: string; alive_prompt: string; return_line: string }[]
}
const WORLD_ID = readFileSync(join(HERE, '..', 'spec', 'world-id.txt'), 'utf8').trim()
const CAMERA = ' Wide establishing view, eye level. Photorealistic, cinematic 35mm.'

async function main(): Promise<void> {
  const store = new LocalWorldStore(fileStore(defaultStorePath()))
  const rev = (await store.getScene(WORLD_ID)).rev
  const ops: Record<string, unknown>[] = []
  for (const mem of SPEC.memories) {
    ops.push({ op: 'update_event', name: `pickup_${mem.id}`, base: mem.alive_prompt + CAMERA })
    ops.push({ op: 'update_event', name: `put_back_${mem.id}`, narration: mem.return_line })
  }
  const result = await store.applyOps(WORLD_ID, ops, rev)
  console.log(`${ops.length} ops → rev ${result.rev}`)
  for (const d of result.diagnostics ?? []) console.log(`  [${d.severity}] ${d.lint}: ${d.message}`)
  const verdict = await store.validate(WORLD_ID)
  const linted = await store.lint(WORLD_ID)
  console.log(`validate: ${verdict.ok ? 'OK' : 'FAILED'} · lint: ${linted.ok ? 'OK' : 'FAILED'}`)
  if (!verdict.ok || !linted.ok) {
    for (const d of [...verdict.diagnostics, ...linted.diagnostics]) console.log(`  [${d.severity}] ${d.lint}: ${d.message}`)
    process.exit(1)
  }
}

void main().catch((e: unknown) => { console.error(String(e)); process.exit(1) })
