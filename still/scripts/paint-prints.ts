/**
 * STILL — the deck's cards: each final memory world as an AGED PRINT with a
 * white border (the photograph lying in the shoebox / hanging on the wall).
 *
 *   npx tsx scripts/paint-prints.ts
 */
import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const SEEDS = join(HERE, '..', 'seeds')
const PHOTOS = join(HERE, '..', '..', 'alakazam-studio', 'public', 'photos')

function key(): string {
  const raw = readFileSync(join(HERE, '..', '..', 'room9', '.env'), 'utf8')
  const m = /^OPENAI_API_KEY=(.+)$/m.exec(raw)
  if (!m) throw new Error('OPENAI_API_KEY missing from room9/.env')
  return m[1].trim()
}

async function main(): Promise<void> {
  for (const id of ['mem_picnic', 'mem_bike', 'mem_kitchen', 'mem_lake78', 'mem_family']) {
    const out = join(PHOTOS, `${id}.png`)
    if (existsSync(out)) { console.log(`skip ${id} (exists)`); continue }
    const res = await fetch('https://api.openai.com/v1/images/edits', {
      method: 'POST',
      headers: { Authorization: `Bearer ${key()}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'gpt-image-2',
        size: '1536x1024',
        prompt: 'Turn this exact photograph into the aged developed print lying in a shoebox: the same image, slightly faded and colour-shifted with film grain, a clean white photographic border all the way round, one soft crease across a corner.',
        images: [{
          image_url: `data:image/png;base64,${readFileSync(join(SEEDS, `${id}_world.png`)).toString('base64')}`,
        }],
      }),
    }).catch((e: unknown) => e as Response)
    if (res instanceof Error || !res.ok) {
      throw new Error(`${id}: ${res instanceof Error ? res.message : `${res.status} — ${(await res.text()).slice(0, 200)}`}`)
    }
    const json: any = await res.json()
    const b64 = json?.data?.[0]?.b64_json
    if (!b64) throw new Error(`${id}: no image in response`)
    writeFileSync(out, Buffer.from(b64, 'base64'))
    console.log(`print painted: public/photos/${id}.png`)
  }
}

void main().catch((e: unknown) => { console.error(String(e)); process.exit(1) })
