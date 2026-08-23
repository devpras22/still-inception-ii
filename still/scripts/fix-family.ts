/**
 * STILL — the family fix. The room now stages the family around the shoebox,
 * the opening narration is Ellen's dialogue instead of stage directions, the
 * choice deck gets the authored labels, the memory captions name their
 * narrator, and the HUD line lives on the world doc.
 *
 *   npx tsx scripts/fix-family.ts
 */
import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { fileStore, defaultStorePath } from '../../alakazam-studio/src/world/store/file.node'
import { LocalWorldStore } from '../../alakazam-studio/src/world/store/local'

const HERE = dirname(fileURLToPath(import.meta.url))
const SPEC = JSON.parse(readFileSync(join(HERE, '..', 'spec', 'story.json'), 'utf8')) as {
  frame: { state: string; prompt: string; narration: string }
  ending: { state: string; prompt: string }
  memories: { id: string; label: string; voice: string; final?: boolean }[]
  voice_cast: Record<string, { voice: string; instructions: string }>
}
const WORLD_ID = readFileSync(join(HERE, '..', 'spec', 'world-id.txt'), 'utf8').trim()
const STUDIO = join(HERE, '..', '..', 'alakazam-studio')

function seedDataUrl(id: string): string {
  const p = join(HERE, '..', 'seeds', `${id}.png`)
  if (!existsSync(p)) throw new Error(`seed ${p} missing`)
  return `data:image/png;base64,${readFileSync(p).toString('base64')}`
}

async function main(): Promise<void> {
  const store = new LocalWorldStore(fileStore(defaultStorePath()))
  const rev = (await store.getScene(WORLD_ID)).rev

  const ops: Record<string, unknown>[] = [
    {
      op: 'update_state', id: SPEC.frame.state,
      base: SPEC.frame.prompt,
      narration: SPEC.frame.narration,
      seedFrame: { src: seedDataUrl('living_room') },
    },
    { op: 'set_entrance', state: SPEC.frame.state, image: { src: seedDataUrl('living_room') } },
    {
      op: 'update_state', id: SPEC.ending.state,
      base: SPEC.ending.prompt,
      seedFrame: { src: seedDataUrl('the_album') },
    },
  ]

  for (const mem of SPEC.memories) {
    ops.push({ op: 'update_event', name: `pickup_${mem.id}`, label: mem.label })
    // Cutscenes update as remove+re-add; the caption now names the narrator.
    ops.push({ op: 'remove_cutscene', id: `cut_${mem.id}` })
    ops.push({
      op: 'add_cutscene', id: `cut_${mem.id}`, label: mem.label,
      video: `/clips/still_${mem.id}.webm`,
      from: SPEC.frame.state, to: mem.final ? 'the_album' : SPEC.frame.state,
      subtitle: `ELLEN: ${mem.voice}`,
    })
  }

  const result = await store.applyOps(WORLD_ID, ops, rev)
  console.log(`${ops.length} ops → rev ${result.rev}`)
  for (const d of result.diagnostics ?? []) console.log(`  [${d.severity}] ${d.lint}: ${d.message}`)

  // World-level hudLine rides the open schema, same as choiceMode/music.
  const file = defaultStorePath()
  const outer = JSON.parse(readFileSync(file, 'utf8')) as Record<string, string>
  const db = JSON.parse(outer['alakazam-studio:worlds:v1']) as { worlds: { id: string; world: Record<string, unknown> }[] }
  const mine = db.worlds.find((w) => w.id === WORLD_ID)
  if (!mine) throw new Error('world vanished from store')
  mine.world['hudLine'] = 'the shoebox is on the table — pick up a photograph'
  mine.world['voicePart'] = { cast: true, ...SPEC.voice_cast['ellen'] }
  outer['alakazam-studio:worlds:v1'] = JSON.stringify(db)
  writeFileSync(file, JSON.stringify(outer))
  console.log('hudLine · voicePart written')

  const verdict = await store.validate(WORLD_ID)
  const linted = await store.lint(WORLD_ID)
  console.log(`validate: ${verdict.ok ? 'OK' : 'FAILED'} · lint: ${linted.ok ? 'OK' : 'FAILED'}`)
  for (const d of [...verdict.diagnostics, ...linted.diagnostics]) console.log(`  [${d.severity}] ${d.lint}: ${d.message}`)
  if (!verdict.ok || !linted.ok) process.exit(1)
}

void main().catch((e: unknown) => { console.error(String(e)); process.exit(1) })
