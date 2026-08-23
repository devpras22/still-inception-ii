/**
 * STILL — the staged room. The shoebox holds three prints (one-shot pickups);
 * when all three are seen, "the shoebox is empty" turns the SAME live session
 * toward the room itself (a prompt-steered state, no reseed): the framed lake
 * photograph above the piano, then the family frame on the bookshelf — the
 * last one ends the film. Not five cards in a row: a box, then a room.
 *
 *   npx tsx scripts/fix-stages.ts
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { fileStore, defaultStorePath } from '../../alakazam-studio/src/world/store/file.node'
import { LocalWorldStore } from '../../alakazam-studio/src/world/store/local'

const HERE = dirname(fileURLToPath(import.meta.url))
const SPEC = JSON.parse(readFileSync(join(HERE, '..', 'spec', 'story.json'), 'utf8')) as {
  frame: { state: string; prompt: string }
  staging: {
    reveal_state: string; reveal_prompt: string; reveal_narration: string
    box_done_label: string; grants: Record<string, string>
  }
  memories: { id: string; label: string; voice: string; final?: boolean }[]
  ending: { state: string }
}
const WORLD_ID = readFileSync(join(HERE, '..', 'spec', 'world-id.txt'), 'utf8').trim()
const STUDIO = join(HERE, '..', '..', 'alakazam-studio')

const byId = (id: string) => SPEC.memories.find((m) => m.id === id)!
const G = SPEC.staging.grants

async function main(): Promise<void> {
  const store = new LocalWorldStore(fileStore(defaultStorePath()))
  const rev = (await store.getScene(WORLD_ID)).rev
  const ops: Record<string, unknown>[] = []

  // The room after the box: a state with NO seed — arriving there steers the
  // living session with a prompt instead of reseeding, so the family never
  // blinks out and the walk around the room keeps its session.
  ops.push({
    op: 'add_state', id: SPEC.staging.reveal_state,
    base: SPEC.staging.reveal_prompt,
    narration: SPEC.staging.reveal_narration,
  })
  ops.push({
    op: 'add_event',
    name: 'box_done', kind: 'transition',
    from: [SPEC.frame.state], to: SPEC.staging.reveal_state,
    base: SPEC.staging.reveal_prompt,
    label: SPEC.staging.box_done_label,
    hotkey: '4',
    requires: [G['mem_picnic'], G['mem_bike'], G['mem_kitchen']],
  })

  for (const mem of SPEC.memories) {
    const grant = G[mem.id] ? [G[mem.id]] : undefined
    const inRoom = mem.id === 'mem_lake78' || mem.final
    ops.push({
      op: 'update_event', name: `pickup_${mem.id}`,
      ...(inRoom ? { from: [SPEC.staging.reveal_state] } : {}),
      label: mem.label,
      oneShot: true,
      ...(grant ? { grants: grant } : {}),
      ...(mem.final ? { requires: [G['mem_lake78']], hotkey: '2' } : { hotkey: mem.id === 'mem_lake78' ? '1' : String(SPEC.memories.indexOf(mem) + 1) }),
    })
    // Cutscenes update as remove+re-add; the room-phase pair now leaves from
    // and returns to the reveal state.
    if (inRoom) {
      ops.push({ op: 'remove_cutscene', id: `cut_${mem.id}` })
      ops.push({
        op: 'add_cutscene', id: `cut_${mem.id}`, label: mem.label,
        video: `/clips/still_${mem.id}.webm`,
        from: SPEC.staging.reveal_state,
        to: mem.final ? SPEC.ending.state : SPEC.staging.reveal_state,
        subtitle: `ELLEN: ${mem.voice}`,
      })
    }
  }

  const result = await store.applyOps(WORLD_ID, ops, rev)
  console.log(`${ops.length} ops → rev ${result.rev}`)
  for (const d of result.diagnostics ?? []) console.log(`  [${d.severity}] ${d.lint}: ${d.message}`)

  // The HUD line now teaches the walk as well as the pickup.
  const file = defaultStorePath()
  const outer = JSON.parse(readFileSync(file, 'utf8')) as Record<string, string>
  const db = JSON.parse(outer['alakazam-studio:worlds:v1']) as { worlds: { id: string; world: Record<string, unknown> }[] }
  const mine = db.worlds.find((w) => w.id === WORLD_ID)
  if (!mine) throw new Error('world vanished from store')
  mine.world['hudLine'] = 'pick up a photograph — or walk around the room (WASD)'
  outer['alakazam-studio:worlds:v1'] = JSON.stringify(db)
  writeFileSync(file, JSON.stringify(outer))
  console.log('hudLine updated')

  const verdict = await store.validate(WORLD_ID)
  const linted = await store.lint(WORLD_ID)
  console.log(`validate: ${verdict.ok ? 'OK' : 'FAILED'} · lint: ${linted.ok ? 'OK' : 'FAILED'}`)
  for (const d of [...verdict.diagnostics, ...linted.diagnostics]) console.log(`  [${d.severity}] ${d.lint}: ${d.message}`)
  if (!verdict.ok || !linted.ok) process.exit(1)
}

void main().catch((e: unknown) => { console.error(String(e)); process.exit(1) })
