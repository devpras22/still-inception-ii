/**
 * STILL — names each state's ambience loop. The files live in the studio's
 * public/ambience/ (generated in the fish.audio web app; see the README
 * there). A missing file is never an error — the bed plays alone.
 *
 *   npx tsx scripts/fix-ambience.ts
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { defaultStorePath } from '../../alakazam-studio/src/world/store/file.node'

const HERE = dirname(fileURLToPath(import.meta.url))
const WORLD_ID = readFileSync(join(HERE, '..', 'spec', 'world-id.txt'), 'utf8').trim()

// Verified by transcription (whisper): street and lake carry no speech,
// dinner is music-only, house and picnic are fish-generated. kitchen.mp3 —
// a Radio Aporee field recording — turned out to be a news broadcast about
// a Belarus detention, so it is not mapped anywhere. The kitchen's prompt
// has "a small radio on the counter": dinner's faint music IS that radio.
// The Thanksgiving table wants family murmur — house.mp3 is a gathering bed.
const AMBIENCE: Record<string, string> = {
  living_room: '/ambience/house.mp3',
  room_open: '/ambience/house.mp3',
  mem_picnic: '/ambience/picnic.mp3',
  mem_bike: '/ambience/street.mp3',
  mem_kitchen: '/ambience/dinner.mp3',
  mem_lake78: '/ambience/lake.mp3',
  mem_family: '/ambience/house.mp3',
}

async function main(): Promise<void> {
  const file = defaultStorePath()
  const outer = JSON.parse(readFileSync(file, 'utf8')) as Record<string, string>
  const db = JSON.parse(outer['alakazam-studio:worlds:v1']) as { worlds: { id: string; world: Record<string, unknown> }[] }
  const mine = db.worlds.find((w) => w.id === WORLD_ID)
  if (!mine) throw new Error('world vanished from store')
  mine.world['ambience'] = AMBIENCE
  outer['alakazam-studio:worlds:v1'] = JSON.stringify(db)
  writeFileSync(file, JSON.stringify(outer))
  console.log('ambience map written:', Object.keys(AMBIENCE).join(', '))
}

void main().catch((e: unknown) => { console.error(String(e)); process.exit(1) })
