/**
 * STILL — make the world deployable.
 *
 * The authored world carries every seed photograph as a base64 data URL
 * (~30MB) — fine for the file store the studio edits against, hopeless for a
 * static deploy. This pulls every data URL out into public/seeds/*.png,
 * rewrites the references to /seeds/<name>.png, and writes the slimmed world
 * record to public/still-world.json — the file the deployed build serves as
 * the world, a few KB.
 *
 *   npx tsx scripts/slim-world.ts
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createHash } from 'node:crypto'
import { defaultStorePath } from '../../alakazam-studio/src/world/store/file.node'

const HERE = dirname(fileURLToPath(import.meta.url))
const WORLD_ID = readFileSync(join(HERE, '..', 'spec', 'world-id.txt'), 'utf8').trim()
const STUDIO_PUBLIC = join(HERE, '..', '..', 'alakazam-studio', 'public')

/** Walk any JSON value; every string that is a data: URL becomes a file and
 *  the reference becomes its /seeds/ URL. Content-hash names so a re-run is
 *  idempotent and unrelated images never collide. */
function extract(value: unknown, write: (name: string, buf: Buffer) => string): unknown {
  if (typeof value === 'string') {
    const m = /^data:(image\/(?:png|jpeg|jpg|webp));base64,(.+)$/.exec(value)
    if (!m) return value
    const ext = m[1].split('/')[1].replace('jpeg', 'jpg')
    const buf = Buffer.from(m[2], 'base64')
    const name = `${createHash('sha1').update(buf).digest('hex').slice(0, 16)}.${ext}`
    return write(name, buf)
  }
  if (Array.isArray(value)) return value.map((v) => extract(v, write))
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) out[k] = extract(v, write)
    return out
  }
  return value
}

async function main(): Promise<void> {
  const outer = JSON.parse(readFileSync(defaultStorePath(), 'utf8')) as Record<string, string>
  const db = JSON.parse(outer['alakazam-studio:worlds:v1']) as { worlds: { id: string }[] }
  const rec = db.worlds.find((w) => w.id === WORLD_ID)
  if (!rec) throw new Error(`world ${WORLD_ID} not found in ${defaultStorePath()}`)

  mkdirSync(join(STUDIO_PUBLIC, 'seeds'), { recursive: true })
  const seen = new Map<string, string>()
  const before = JSON.stringify(rec).length
  const slim = extract(rec, (name, buf) => {
    const hit = seen.get(name)
    if (hit) return hit
    writeFileSync(join(STUDIO_PUBLIC, 'seeds', name), buf)
    const url = `/seeds/${name}`
    seen.set(name, url)
    return url
  }) as Record<string, unknown>
  const after = JSON.stringify(slim).length

  // The player reads the record's own world slice (worldRef = getWorld().world)
  // — serve exactly that shape plus the fields getWorld() spreads on top.
  const doc = { ...(slim.world as Record<string, unknown>), schemaVersion: 'still-demo-1' }
  writeFileSync(join(STUDIO_PUBLIC, 'still-world.json'), JSON.stringify(doc))
  console.log(`record ${Math.round(before / 1024)}KB → ${Math.round(after / 1024)}KB · ${seen.size} seed files · still-world.json written`)
  console.log([...seen.values()].join('\n'))
}

void main().catch((e: unknown) => { console.error(String(e)); process.exit(1) })
