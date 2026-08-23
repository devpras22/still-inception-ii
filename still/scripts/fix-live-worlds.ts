/**
 * STILL — the memories become worlds. Each photograph's clip is now a DOOR:
 * it lands in a seeded state of its own, so you stand inside the memory as a
 * live session you can look around, Ellen speaking a present-tense line over
 * it. One card — "put it back" — returns to the table. The staged arc holds:
 * three prints in the shoebox, then the room itself (piano wall, bookshelf),
 * then the last one, then the album.
 *
 *   npx tsx scripts/fix-live-worlds.ts
 */
import { readFileSync, writeFileSync, existsSync } from 'node:fs'
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
  memories: {
    id: string; label: string; alive_prompt: string; voice: string
    in_world: string; return_label: string; final?: boolean
  }[]
  ending: { state: string; prompt: string }
}
const WORLD_ID = readFileSync(join(HERE, '..', 'spec', 'world-id.txt'), 'utf8').trim()
const STUDIO = join(HERE, '..', '..', 'alakazam-studio')
const G = SPEC.staging.grants

const CAMERA = ' Wide establishing view, eye level. Photorealistic, cinematic 35mm.'

function seedDataUrl(id: string): string {
  const p = join(HERE, '..', 'seeds', `${id}.png`)
  if (!existsSync(p)) throw new Error(`seed ${p} missing — run paint-worlds first`)
  return `data:image/png;base64,${readFileSync(p).toString('base64')}`
}

async function main(): Promise<void> {
  const store = new LocalWorldStore(fileStore(defaultStorePath()))
  const scene = await store.getScene(WORLD_ID)
  const world = await store.getWorld(WORLD_ID)
  const rev = scene.rev
  // add_event drops authored gating fields (label/requires/grants) at the
  // boundary — update_event merges them wholesale — so every add is followed
  // by its update, and re-runs skip adds that already landed.
  const hasState = (id: string) => id in scene.states
  const hasEvent = (name: string) => scene.events.some((e) => e.name === name)
  const hasCut = (id: string) => (world.cutscenes ?? []).some((c) => c.id === id)
  const ops: Record<string, unknown>[] = []

  // The room after the box — its own seed (the emptied table, the wall
  // photograph and the bookshelf frame visible), so returning from the wall
  // memories reseeds somewhere honest.
  if (!hasState(SPEC.staging.reveal_state)) {
    ops.push({
      op: 'add_state', id: SPEC.staging.reveal_state,
      base: SPEC.staging.reveal_prompt + CAMERA,
      narration: SPEC.staging.reveal_narration,
      seedFrame: { src: seedDataUrl(SPEC.staging.reveal_state) },
    })
  }
  if (!hasEvent('box_done')) {
    ops.push({
      op: 'add_event', name: 'box_done', kind: 'transition',
      from: [SPEC.frame.state], to: SPEC.staging.reveal_state,
      base: SPEC.staging.reveal_prompt,
    })
  }
  ops.push({
    op: 'update_event', name: 'box_done',
    detail: SPEC.staging.box_done_label, hotkey: '4', oneShot: true,
    requires: [G['mem_picnic'], G['mem_bike'], G['mem_kitchen']],
  })

  for (const mem of SPEC.memories) {
    const fromRoom = mem.id === 'mem_lake78' || mem.final
    const origin = fromRoom ? SPEC.staging.reveal_state : SPEC.frame.state
    const homeBase = fromRoom ? SPEC.staging.reveal_prompt : SPEC.frame.prompt
    const returnDest = mem.final ? SPEC.ending.state : origin

    if (!hasState(mem.id)) {
      ops.push({
        op: 'add_state', id: mem.id,
        base: mem.alive_prompt + CAMERA,
        narration: mem.in_world,
        seedFrame: { src: seedDataUrl(`${mem.id}_world`) },
      })
    }
    ops.push({
      op: 'update_event', name: `pickup_${mem.id}`,
      from: [origin], detail: mem.label, oneShot: true,
      hotkey: fromRoom ? (mem.final ? '2' : '1') : String(SPEC.memories.indexOf(mem) + 1),
      ...(G[mem.id] ? { grants: [G[mem.id]] } : {}),
      ...(mem.final ? { requires: [G['mem_lake78']] } : {}),
    })
    if (hasCut(`cut_${mem.id}`)) ops.push({ op: 'remove_cutscene', id: `cut_${mem.id}` })
    ops.push({
      op: 'add_cutscene', id: `cut_${mem.id}`, label: mem.label,
      video: `/clips/still_${mem.id}.webm`,
      from: origin, to: mem.id,
      subtitle: `ELLEN: ${mem.voice}`,
    })
    if (!hasEvent(`put_back_${mem.id}`)) {
      ops.push({
        op: 'add_event', name: `put_back_${mem.id}`, kind: 'transition',
        from: [mem.id], to: returnDest,
        base: mem.final ? SPEC.ending.prompt : homeBase,
      })
    }
    ops.push({
      op: 'update_event', name: `put_back_${mem.id}`,
      detail: mem.return_label, hotkey: '1',
    })
  }

  const result = await store.applyOps(WORLD_ID, ops, rev)
  console.log(`${ops.length} ops → rev ${result.rev}`)
  for (const d of result.diagnostics ?? []) console.log(`  [${d.severity}] ${d.lint}: ${d.message}`)

  const file = defaultStorePath()
  const outer = JSON.parse(readFileSync(file, 'utf8')) as Record<string, string>
  const db = JSON.parse(outer['alakazam-studio:worlds:v1']) as { worlds: { id: string; world: Record<string, unknown> }[] }
  const mine = db.worlds.find((w) => w.id === WORLD_ID)
  if (!mine) throw new Error('world vanished from store')
  mine.world['hudLine'] = 'pick up a photograph — and look around (WASD)'
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
