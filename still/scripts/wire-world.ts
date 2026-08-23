/**
 * STILL — wires the film: one live living room (the session never leaves it),
 * five photographs as choice events whose clips play over the room, and the
 * ending state when the last photograph is picked up. The world carries its
 * own cast, track and photo cards on the open schema.
 *
 *   npx tsx scripts/wire-world.ts
 */
import { readFileSync, writeFileSync, existsSync, copyFileSync, mkdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { fileStore, defaultStorePath } from '../../alakazam-studio/src/world/store/file.node'
import { LocalWorldStore } from '../../alakazam-studio/src/world/store/local'

const HERE = dirname(fileURLToPath(import.meta.url))
const SPEC = JSON.parse(readFileSync(join(HERE, '..', 'spec', 'story.json'), 'utf8')) as {
  name: string
  logline: string
  frame: { state: string; prompt: string; narration: string }
  memories: { id: string; label: string; hint: string; alive_prompt: string; voice: string; final?: boolean }[]
  ending: { state: string; title: string; subtitle: string; prompt: string; voice: string }
  voice_cast: Record<string, { voice: string; instructions: string }>
}

const STUDIO = join(HERE, '..', '..', 'alakazam-studio')
const SEEDS = join(HERE, '..', 'seeds')
const ID_FILE = join(HERE, '..', 'spec', 'world-id.txt')

function seedUrl(id: string): string | undefined {
  const p = join(SEEDS, `${id}.png`)
  return existsSync(p) ? `data:image/png;base64,${readFileSync(p).toString('base64')}` : undefined
}

async function main(): Promise<void> {
  if (existsSync(ID_FILE)) throw new Error(`already wired — ${ID_FILE} exists`)
  const store = new LocalWorldStore(fileStore(defaultStorePath()))
  const created = await store.createWorld({ premise: SPEC.logline, name: SPEC.name })
  const worldId = created.worldId
  const rev = (await store.getScene(worldId)).rev

  // The photographs live as servable files for the choice cards.
  const photosDir = join(STUDIO, 'public', 'photos')
  mkdirSync(photosDir, { recursive: true })
  for (const mem of SPEC.memories) {
    const p = join(SEEDS, `${mem.id}.png`)
    if (existsSync(p)) copyFileSync(p, join(photosDir, `${mem.id}.png`))
  }

  const ops: Record<string, unknown>[] = []

  ops.push({
    op: 'add_state', id: SPEC.frame.state,
    base: SPEC.frame.prompt,
    narration: SPEC.frame.narration,
    ...(seedUrl('living_room') ? { seedFrame: { src: seedUrl('living_room')! } } : {}),
  })
  ops.push({
    op: 'add_state', id: SPEC.ending.state,
    base: SPEC.ending.prompt,
    narration: SPEC.ending.voice,
    ...(seedUrl('the_album') ? { seedFrame: { src: seedUrl('the_album')! } } : {}),
  })

  // Clips first — a transition may only name a cut that exists.
  const photoCards: Record<string, string> = {}
  for (const mem of SPEC.memories) {
    const clip = `/clips/still_${mem.id}.webm`
    if (!existsSync(join(STUDIO, 'public', 'clips', `still_${mem.id}.webm`))) {
      throw new Error(`clip ${clip} not generated yet — run the takes first`)
    }
    const dest = mem.final ? SPEC.ending.state : SPEC.frame.state
    ops.push({
      op: 'add_cutscene', id: `cut_${mem.id}`, label: mem.label,
      video: clip, from: SPEC.frame.state, to: dest,
      subtitle: mem.voice,
    })
    const eventName = `pickup_${mem.id}`
    ops.push({
      op: 'add_transition', name: eventName,
      from: [SPEC.frame.state], to: `cut_${mem.id}`,
      hotkey: String((SPEC.memories.indexOf(mem) + 1) % 10),
      base: dest === SPEC.frame.state ? SPEC.frame.prompt : SPEC.ending.prompt,
    })
    photoCards[eventName] = `/photos/${mem.id}.png`
  }

  ops.push({ op: 'set_entrance', state: SPEC.frame.state, ...(seedUrl('living_room') ? { image: { src: seedUrl('living_room')! } } : {}) })
  ops.push({ op: 'set_state_ending', state: SPEC.ending.state, kind: 'win', title: SPEC.ending.title, subtitle: SPEC.ending.subtitle })
  ops.push({ op: 'set_narrate', narrate: true })

  const result = await store.applyOps(worldId, ops, rev)
  console.log(`created ${worldId} · ${ops.length} ops → rev ${result.rev}`)
  for (const d of result.diagnostics ?? []) console.log(`  [${d.severity}] ${d.lint}: ${d.message}`)

  // World-level fields ride the open schema exactly as the store writes them.
  const file = defaultStorePath()
  const outer = JSON.parse(readFileSync(file, 'utf8')) as Record<string, string>
  const db = JSON.parse(outer['alakazam-studio:worlds:v1']) as { worlds: { id: string; world: Record<string, unknown> }[] }
  const mine = db.worlds.find((w) => w.id === worldId)
  if (!mine) throw new Error('world vanished from store after applyOps')
  mine.world['choiceMode'] = true
  mine.world['music'] = '/music/still.mp3'
  mine.world['voicePart'] = { cast: true, ...SPEC.voice_cast['ellen'] }
  mine.world['photoCards'] = photoCards
  outer['alakazam-studio:worlds:v1'] = JSON.stringify(db)
  writeFileSync(file, JSON.stringify(outer))
  console.log('choiceMode · music · voicePart · photoCards written')

  const verdict = await store.validate(worldId)
  const linted = await store.lint(worldId)
  console.log(`validate: ${verdict.ok ? 'OK' : 'FAILED'} · lint: ${linted.ok ? 'OK' : 'FAILED'}`)
  for (const d of [...verdict.diagnostics, ...linted.diagnostics]) console.log(`  [${d.severity}] ${d.lint}: ${d.message}`)
  if (!verdict.ok || !linted.ok) process.exit(1)
  writeFileSync(ID_FILE, worldId)
  console.log(`world id saved → ${ID_FILE}`)
}

void main().catch((e: unknown) => { console.error(String(e)); process.exit(1) })
