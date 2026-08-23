/**
 * STILL — Ellen's voice on the five memory clips. Warm, a little hoarse,
 * grief under the words. The room and ending lines are spoken live by the
 * player with the same cast (the world carries it — see wire-world).
 *
 *   npx tsx scripts/gen-voice.ts && npx tsx scripts/mux-clips.ts
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const SPEC = JSON.parse(readFileSync(join(HERE, '..', 'spec', 'story.json'), 'utf8')) as {
  memories: { id: string; voice: string }[]
  voice_cast: Record<string, { voice: string; instructions: string }>
}

function env(key: string): string {
  const raw = readFileSync(join(HERE, '..', '..', 'room9', '.env'), 'utf8')
  const m = new RegExp(`^${key}=(.+)$`, 'm').exec(raw)
  if (!m) throw new Error(`${key} missing from room9/.env`)
  return m[1].trim()
}

async function main(): Promise<void> {
  const key = env('OPENAI_API_KEY')
  const cast = SPEC.voice_cast['ellen']
  for (const mem of SPEC.memories) {
    const res = await fetch('https://api.openai.com/v1/audio/speech', {
      method: 'POST',
      headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: 'gpt-4o-mini-tts', voice: cast.voice, input: mem.voice, response_format: 'mp3', instructions: cast.instructions }),
    })
    if (!res.ok) throw new Error(`${mem.id}: HTTP ${res.status} — ${(await res.text()).slice(0, 200)}`)
    const bytes = Buffer.from(await res.arrayBuffer())
    writeFileSync(join(HERE, '..', 'voice', `${mem.id}.mp3`), bytes)
    console.log(`${mem.id} — ${(bytes.length / 1024).toFixed(0)} KB (${cast.voice}, directed)`)
  }
  console.log('all memory lines voiced — now mux-clips.ts')
}

void main().catch((e: unknown) => { console.error(String(e)); process.exit(1) })
