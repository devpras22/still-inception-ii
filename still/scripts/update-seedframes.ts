/**
 * STILL — pushes freshly painted seeds into the world doc. seedFrames are
 * baked into the states as data URLs, so a repainted seed needs an
 * update_state to take effect in play.
 *
 *   npx tsx scripts/update-seedframes.ts
 */
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { fileStore, defaultStorePath } from '../../alakazam-studio/src/world/store/file.node'
import { LocalWorldStore } from '../../alakazam-studio/src/world/store/local'

const HERE = dirname(fileURLToPath(import.meta.url))
const WORLD_ID = readFileSync(join(HERE, '..', 'spec', 'world-id.txt'), 'utf8').trim()

const SEEDED: Record<string, string> = {
  living_room: 'living_room',
  room_open: 'room_open',
  the_album: 'the_album',
  mem_picnic: 'mem_picnic_world',
  mem_bike: 'mem_bike_world',
  mem_kitchen: 'mem_kitchen_world',
  mem_lake78: 'mem_lake78_world',
  mem_family: 'mem_family_world',
}

async function main(): Promise<void> {
  const store = new LocalWorldStore(fileStore(defaultStorePath()))
  const rev = (await store.getScene(WORLD_ID)).rev
  const ops: Record<string, unknown>[] = []
  for (const [state, seed] of Object.entries(SEEDED)) {
    ops.push({
      op: 'update_state', id: state,
      seedFrame: { src: `data:image/png;base64,${readFileSync(join(HERE, '..', 'seeds', `${seed}.png`)).toString('base64')}` },
    })
  }
  ops.push({
    op: 'set_entrance', state: 'living_room',
    image: { src: `data:image/png;base64,${readFileSync(join(HERE, '..', 'seeds', 'living_room.png')).toString('base64')}` },
  })
  const result = await store.applyOps(WORLD_ID, ops, rev)
  console.log(`${ops.length} ops → rev ${result.rev}`)
  const verdict = await store.validate(WORLD_ID)
  const linted = await store.lint(WORLD_ID)
  console.log(`validate: ${verdict.ok ? 'OK' : 'FAILED'} · lint: ${linted.ok ? 'OK' : 'FAILED'}`)
  if (!verdict.ok || !linted.ok) {
    for (const d of [...verdict.diagnostics, ...linted.diagnostics]) console.log(`  [${d.severity}] ${d.lint}: ${d.message}`)
    process.exit(1)
  }
}

void main().catch((e: unknown) => { console.error(String(e)); process.exit(1) })
