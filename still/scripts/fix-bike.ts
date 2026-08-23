/**
 * STILL — the bike rides, the rooms stand alone.
 *
 * 1. mem_bike's SUBJECT becomes Maya on the bicycle (WASD pedals; Marion is
 *    cast a few steps behind). Her arrival line now sends the player riding.
 * 2. the_album and room_open stop saying "the same living room" — a base
 *    prompt is self-contained; the model has no earlier scene to refer to.
 * 3. Every memory teaches its own verb: a per-state hudLine ("W / S — pedal"),
 *    which the Player prefers over the world's global line.
 *
 *   npx tsx scripts/fix-bike.ts
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { fileStore, defaultStorePath } from '../../alakazam-studio/src/world/store/file.node'
import { LocalWorldStore } from '../../alakazam-studio/src/world/store/local'

const HERE = dirname(fileURLToPath(import.meta.url))
const SPEC = JSON.parse(readFileSync(join(HERE, '..', 'spec', 'story.json'), 'utf8')) as {
  memories: { id: string; alive_prompt: string; hud?: string; in_world?: string; voice?: string; return_line?: string }[]
  staging: { reveal_state: string; reveal_prompt: string; reveal_narration: string }
  ending: { state: string; prompt: string; voice: string }
}
const WORLD_ID = readFileSync(join(HERE, '..', 'spec', 'world-id.txt'), 'utf8').trim()

async function main(): Promise<void> {
  const store = new LocalWorldStore(fileStore(defaultStorePath()))
  const rev = (await store.getScene(WORLD_ID)).rev
  const ops: Record<string, unknown>[] = []

  ops.push({ op: 'update_state', id: SPEC.staging.reveal_state, base: SPEC.staging.reveal_prompt, narration: SPEC.staging.reveal_narration })
  ops.push({ op: 'update_state', id: SPEC.ending.state, base: SPEC.ending.prompt, narration: SPEC.ending.voice })
  ops.push({ op: 'update_event', name: 'box_done', base: SPEC.staging.reveal_prompt })
  ops.push({ op: 'update_event', name: 'put_back_mem_lake78', base: SPEC.staging.reveal_prompt })
  ops.push({ op: 'update_event', name: 'put_back_mem_family', base: SPEC.ending.prompt })

  for (const mem of SPEC.memories) {
    ops.push({ op: 'update_state', id: mem.id, base: mem.alive_prompt })
    ops.push({ op: 'update_event', name: `pickup_${mem.id}`, base: mem.alive_prompt })
    if (mem.voice || mem.in_world) {
      // One spoken passage on entry: the line over the photo flows into the
      // line standing inside the memory. The Player shows the event's line if
      // it has one, else the state's — so both carry the combined text.
      const passage = [mem.voice, mem.in_world].filter(Boolean).join(' ')
      ops.push({ op: 'update_state', id: mem.id, narration: passage })
      ops.push({ op: 'update_event', name: `pickup_${mem.id}`, narration: passage })
    }
    // The authored homecoming line is the IMPROV fallback — it must say what
    // story.json says, or a failed LLM resurrects dead wording.
    if (mem.return_line) ops.push({ op: 'update_event', name: `put_back_${mem.id}`, narration: mem.return_line })
  }

  const result = await store.applyOps(WORLD_ID, ops, rev)
  console.log(`${ops.length} ops → rev ${result.rev}`)
  for (const d of result.diagnostics ?? []) console.log(`  [${d.severity}] ${d.lint}: ${d.message}`)

  // Per-state hudLine rides outside the op schema (like the world-level one).
  const file = defaultStorePath()
  const outer = JSON.parse(readFileSync(file, 'utf8')) as Record<string, string>
  const db = JSON.parse(outer['alakazam-studio:worlds:v1']) as { worlds: { id: string; world: { scene: { states: Record<string, Record<string, unknown>> } } }[] }
  const mine = db.worlds.find((w) => w.id === WORLD_ID)
  if (!mine) throw new Error('world vanished from store')
  let n = 0
  for (const mem of SPEC.memories) {
    if (!mem.hud) continue
    mine.world.scene.states[mem.id]['hudLine'] = mem.hud
    n++
  }
  outer['alakazam-studio:worlds:v1'] = JSON.stringify(db)
  writeFileSync(file, JSON.stringify(outer))
  console.log(`${n} per-state hudLines written`)

  const verdict = await store.validate(WORLD_ID)
  const linted = await store.lint(WORLD_ID)
  console.log(`validate: ${verdict.ok ? 'OK' : 'FAILED'} · lint: ${linted.ok ? 'OK' : 'FAILED'}`)
  if (!verdict.ok || !linted.ok) {
    for (const d of [...verdict.diagnostics, ...linted.diagnostics]) console.log(`  [${d.severity}] ${d.lint}: ${d.message}`)
    process.exit(1)
  }
}

void main().catch((e: unknown) => { console.error(String(e)); process.exit(1) })
