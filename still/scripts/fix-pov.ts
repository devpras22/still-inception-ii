/**
 * STILL — prompts rewritten to lingbot-world-2's own guide (docs.reactor.inc
 * /model-api-reference/lingbot-world-2/prompt-guide): third person, present
 * tense, one cast subject per scene (the subject is what WASD moves), base
 * layer only — still scene, pinned landmarks, use-ready props, no motion
 * verbs, no camera or style words. The engine composes the movement and
 * camera layers itself.
 *
 *   npx tsx scripts/fix-pov.ts
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { fileStore, defaultStorePath } from '../../alakazam-studio/src/world/store/file.node'
import { LocalWorldStore } from '../../alakazam-studio/src/world/store/local'

const HERE = dirname(fileURLToPath(import.meta.url))
const SPEC = JSON.parse(readFileSync(join(HERE, '..', 'spec', 'story.json'), 'utf8')) as {
  frame: { state: string; prompt: string }
  staging: { reveal_state: string; reveal_prompt: string }
  ending: { state: string; prompt: string }
  memories: { id: string; alive_prompt: string }[]
}
const WORLD_ID = readFileSync(join(HERE, '..', 'spec', 'world-id.txt'), 'utf8').trim()

async function main(): Promise<void> {
  const store = new LocalWorldStore(fileStore(defaultStorePath()))
  const rev = (await store.getScene(WORLD_ID)).rev
  const ops: Record<string, unknown>[] = []

  // Room states: base only (no pickups of their own).
  ops.push({ op: 'update_state', id: SPEC.frame.state, base: SPEC.frame.prompt })
  ops.push({ op: 'update_state', id: SPEC.staging.reveal_state, base: SPEC.staging.reveal_prompt })
  ops.push({ op: 'update_state', id: SPEC.ending.state, base: SPEC.ending.prompt })
  // box_done carries the reveal text; returns carry their home room's text.
  ops.push({ op: 'update_event', name: 'box_done', base: SPEC.staging.reveal_prompt })
  for (const mem of SPEC.memories) {
    ops.push({ op: 'update_state', id: mem.id, base: mem.alive_prompt })
    ops.push({ op: 'update_event', name: `pickup_${mem.id}`, base: mem.alive_prompt })
    const home = mem.final ? SPEC.ending.prompt : mem.id === 'mem_lake78' ? SPEC.staging.reveal_prompt : SPEC.frame.prompt
    ops.push({ op: 'update_event', name: `put_back_${mem.id}`, base: home })
  }

  const result = await store.applyOps(WORLD_ID, ops, rev)
  console.log(`${ops.length} ops → rev ${result.rev}`)
  for (const d of result.diagnostics ?? []) console.log(`  [${d.severity}] ${d.lint}: ${d.message}`)

  const file = defaultStorePath()
  const outer = JSON.parse(readFileSync(file, 'utf8')) as Record<string, string>
  const db = JSON.parse(outer['alakazam-studio:worlds:v1']) as { worlds: { id: string; world: Record<string, unknown> }[] }
  const mine = db.worlds.find((w) => w.id === WORLD_ID)
  if (!mine) throw new Error('world vanished from store')
  mine.world['hudLine'] = 'pick up a photograph — WASD walks the scene'
  outer['alakazam-studio:worlds:v1'] = JSON.stringify(db)
  writeFileSync(file, JSON.stringify(outer))

  const verdict = await store.validate(WORLD_ID)
  const linted = await store.lint(WORLD_ID)
  console.log(`validate: ${verdict.ok ? 'OK' : 'FAILED'} · lint: ${linted.ok ? 'OK' : 'FAILED'}`)
  if (!verdict.ok || !linted.ok) {
    for (const d of [...verdict.diagnostics, ...linted.diagnostics]) console.log(`  [${d.severity}] ${d.lint}: ${d.message}`)
    process.exit(1)
  }
}

void main().catch((e: unknown) => { console.error(String(e)); process.exit(1) })
