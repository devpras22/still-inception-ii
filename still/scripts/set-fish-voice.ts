/** STILL — cast Ellen as a designed Fish voice. Args: the candidate id. */
import { readFileSync, writeFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { defaultStorePath } from '../../alakazam-studio/src/world/store/file.node'
const HERE = dirname(fileURLToPath(import.meta.url))
const WORLD_ID = readFileSync(join(HERE, '..', 'spec', 'world-id.txt'), 'utf8').trim()
const id = process.argv[2]
if (!id) throw new Error('usage: npx tsx scripts/set-fish-voice.ts <fish-voice-id>')
const file = defaultStorePath()
const outer = JSON.parse(readFileSync(file, 'utf8')) as Record<string, string>
const db = JSON.parse(outer['alakazam-studio:worlds:v1']) as { worlds: { id: string; world: Record<string, unknown> }[] }
const mine = db.worlds.find((w) => w.id === WORLD_ID)
if (!mine) throw new Error('world missing')
mine.world['voicePart'] = { cast: false, fishVoice: id }
outer['alakazam-studio:worlds:v1'] = JSON.stringify(db)
writeFileSync(file, JSON.stringify(outer))
console.log('Ellen cast as fish voice', id)
