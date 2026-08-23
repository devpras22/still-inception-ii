/**
 * STILL — paints the seven stills: the living room (the Lingbot session's
 * seed), the five photographs (aged prints — the choice cards show them), and
 * the ending room. One Gemini call each, retried.
 *
 *   npx tsx scripts/paint-stills.ts
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const SPEC = JSON.parse(readFileSync(join(HERE, '..', 'spec', 'story.json'), 'utf8')) as {
  frame: { prompt: string }
  memories: { id: string; photo_prompt: string }[]
  ending: { prompt: string }
}

function env(key: string): string {
  const raw = readFileSync(join(HERE, '..', '..', 'room9', '.env'), 'utf8')
  const m = new RegExp(`^${key}=(.+)$`, 'm').exec(raw)
  if (!m) throw new Error(`${key} missing from room9/.env`)
  return m[1].trim()
}

async function paint(name: string, prompt: string): Promise<void> {
  for (let attempt = 1; ; attempt++) {
    const res = await fetch('https://generativelanguage.googleapis.com/v1beta/models/gemini-3-pro-image:generateContent', {
      method: 'POST',
      headers: { 'x-goog-api-key': env('GEMINI_API_KEY'), 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{ parts: [{ text: `${prompt}, photorealistic` }] }],
        generationConfig: { responseModalities: ['IMAGE'], imageConfig: { aspectRatio: '16:9' } },
      }),
    }).catch((e: unknown) => e as Response)
    if (!(res instanceof Error) && res.ok) {
      const json: any = await res.json()
      const part = (json?.candidates?.[0]?.content?.parts ?? []).find((p: any) => p?.inlineData?.data)
      if (part) {
        writeFileSync(join(HERE, '..', 'seeds', `${name}.png`), Buffer.from(part.inlineData.data, 'base64'))
        console.log(`painted ${name}.png`)
        return
      }
      if (attempt >= 3) throw new Error(`${name}: no image part after 3 attempts`)
    } else if (attempt >= 3) {
      const detail = res instanceof Error ? res.message : `${res.status} — ${(await res.text()).slice(0, 200)}`
      throw new Error(`${name} failed after 3 attempts: ${detail}`)
    }
    console.log(`${name} attempt ${attempt} failed — waiting 8s`)
    await new Promise((r) => setTimeout(r, 8000))
  }
}

async function main(): Promise<void> {
  await paint('living_room', SPEC.frame.prompt)
  for (const m of SPEC.memories) await paint(m.id, m.photo_prompt)
  await paint('the_album', SPEC.ending.prompt)
  console.log('all stills painted')
}

void main().catch((e: unknown) => { console.error(String(e)); process.exit(1) })
