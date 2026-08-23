/**
 * STILL — the family chain on gpt-image-2, run ONE STEP AT A TIME so each
 * image can be vision-checked for character/room consistency before the next
 * builds on it:
 *
 *   npx tsx scripts/paint-family.ts living_room     # just that step
 *   npx tsx scripts/paint-family.ts                 # every missing step
 *
 * Steps skip files that already exist — delete a bad one to re-take it.
 */
import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const SEEDS = join(HERE, '..', 'seeds')
const PHOTOS = join(HERE, '..', '..', 'alakazam-studio', 'public', 'photos')
const MODEL = 'gpt-image-2'
const SIZE = '1536x1024'
const FILM = '16:9 landscape, photorealistic, cinematic 35mm film look, warm natural light.'

function key(): string {
  const raw = readFileSync(join(HERE, '..', '..', 'room9', '.env'), 'utf8')
  const m = /^OPENAI_API_KEY=(.+)$/m.exec(raw)
  if (!m) throw new Error('OPENAI_API_KEY missing from room9/.env')
  return m[1].trim()
}

async function call(path: string, payload: Record<string, unknown>): Promise<Buffer> {
  for (let attempt = 1; ; attempt++) {
    const res = await fetch(`https://api.openai.com/v1/images/${path}`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${key()}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    }).catch((e: unknown) => e as Response)
    if (!(res instanceof Error) && res.ok) {
      const json: any = await res.json()
      const b64 = json?.data?.[0]?.b64_json
      if (b64) return Buffer.from(b64, 'base64')
      if (attempt >= 3) throw new Error('no image in response')
    } else if (attempt >= 3) {
      const detail = res instanceof Error ? res.message : `${res.status} — ${(await res.text()).slice(0, 300)}`
      throw new Error(`${path} failed after 3 attempts: ${detail}`)
    }
    console.log(`  attempt ${attempt} failed — waiting 10s`)
    await new Promise((r) => setTimeout(r, 10_000))
  }
}

interface Step {
  name: string
  dir?: string
  inputs: string[]
  prompt: string
}

const STEPS: Step[] = [
  {
    name: 'living_room',
    inputs: ['mem_family_world'],
    prompt: `Using the attached photo only as a face reference: take the adult daughter and the three grandchildren (the teenage boy and the two young girls) — and LEAVE OUT the silver-haired woman in the centre with the wine glass entirely.
Those four people now sit close together around a low wooden coffee table with an open shoebox full of old printed photographs spread out across the table, wearing soft, muted home clothes, leaning in toward the photos, warm and tired.
Setting: a warm, lived-in living room in early evening — worn sofa with knitted throws, soft lamplight, photo frames on the walls, a piano in the corner, and further back a house full of relatives: an aunt carrying a tray of teacups, an uncle in a dark suit by the kitchen doorway, kids on the stairs, coats piled on a chair. ${FILM}`,
  },
  {
    name: 'room_open',
    inputs: ['living_room'],
    prompt: `Edit this image. KEEP THE ROOM AND THE FOUR PEOPLE EXACTLY AS THEY ARE — same sofa, same lamp, same walls, same piano, same people in the same seats, same warm evening light.
Change ONLY these things: the shoebox on the coffee table is now EMPTY and the loose photographs are gone from the table, and now clearly visible on the wall above the piano hangs a large faded framed photograph of a misty lake at dawn, and on the bookshelf stands a small framed family photograph. The four people look up from the empty box toward the photographs around the room.`,
  },
  {
    name: 'mem_picnic_world',
    inputs: ['mem_family_world'],
    prompt: `Using the attached photo only as a face reference for one person: the silver-haired woman in the centre, aged down to 40 — same face, shoulder-length brown hair.
Scene, from a 1986 family album: a lakeside picnic on a checkered blanket — she laughs holding a paper plate; beside her her husband: a tall man with round glasses and a ridiculous wide-brim straw hat, big easy laugh, waving smoke away from a sizzling portable barbecue; a 10-year-old girl with pigtails (the same face as the younger of the two girls in the photo) chases her little brother through tall grass by the water. Warm afternoon light on the lake. ${FILM}`,
  },
  {
    name: 'mem_lake78_world',
    inputs: ['mem_picnic_world', 'mem_family_world'],
    prompt: `Two attached photos: the picnic (for the man) and the family dinner (for the woman's face).
The straw-hat man from the picnic, now 34, no hat, in denim. The woman from the family dinner — the silver-haired one in the centre — aged down to 32, long dark hair, same face.
Scene, 1978: misty dawn on a still lake, the two of them sitting close together on a weathered wooden dock with one fishing rod between them, she leans her head toward his shoulder, about to laugh, mist going gold as the sun rises, loons on the water. ${FILM}`,
  },
  {
    name: 'mem_kitchen_world',
    inputs: ['mem_picnic_world'],
    prompt: `Using the attached photo as a face reference for one person: the 40-year-old woman with shoulder-length brown hair, same face.
Scene, from the family album: the family kitchen at Christmas — she stands at the counter rolling cookie dough with flour on one cheek, mock-scowling at the camera; behind her a teenage girl (her daughter, same family look) sneaks a cookie off a tray, icing bag in hand, both about to crack up. A small radio on the counter, tinsel, cookie tins, flour dust in warm evening light. ${FILM}`,
  },
  {
    name: 'mem_bike_world',
    inputs: ['mem_family_world'],
    prompt: `Two face references from the attached photo: the silver-haired woman in the centre, and the younger of the two girls.
Scene, a bright summer day in 2022: the silver-haired woman, 79, same face and silver bob, running bent low behind a small child's bicycle, one hand on the seat, just letting go; the girl aged down to 5 — small, determined face under a bike helmet — pedalling hard down a quiet suburban sidewalk. Golden late-afternoon light, parked cars, a dog watching from a front yard. ${FILM}`,
  },
  {
    name: 'the_album',
    inputs: ['room_open'],
    prompt: `Edit this image. KEEP THE ROOM EXACTLY AS IT IS — same sofa, lamp, walls, piano with the lake-dawn photograph above it, bookshelf with the family frame.
Change ONLY: it is now late at night, everyone has gone home, the seats are empty; the old photographs from the shoebox are arranged in careful rows across the coffee table, one lamp glows low and golden, two teacups sit on the table, the house is still.`,
  },
]

async function run(step: Step): Promise<void> {
  const outDir = step.dir ?? SEEDS
  const out = join(outDir, `${step.name}.png`)
  if (existsSync(out)) { console.log(`skip ${step.name} (exists)`); return }
  const payload: Record<string, unknown> =
    step.inputs.length === 0
      ? { model: MODEL, prompt: step.prompt, size: SIZE }
      : {
          model: MODEL, prompt: step.prompt, size: SIZE,
          images: step.inputs.map((f) => ({
            image_url: `data:image/png;base64,${readFileSync(join(SEEDS, `${f}.png`)).toString('base64')}`,
          })),
        }
  const buf = await call(step.inputs.length === 0 ? 'generations' : 'edits', payload)
  writeFileSync(out, buf)
  console.log(`painted ${step.name}.png`)
}

async function main(): Promise<void> {
  const only = process.argv[2]
  for (const step of STEPS) {
    if (only && step.name !== only) continue
    await run(step)
  }
  if (only && !STEPS.some((s) => s.name === only)) throw new Error(`no step named ${only}`)
}

void main().catch((e: unknown) => { console.error(String(e)); process.exit(1) })
