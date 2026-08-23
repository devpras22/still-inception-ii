// Drive the kernel agent headlessly against a real model — the parity proof.
import { LocalWorldStore } from '../../src/world/store/local'
import { fileStore, defaultStorePath } from '../../src/world/store/file.node'
import { runGeneration } from '../../src/author/agent/generate'
import { runDoctrine } from '../../src/world/doctrine'
import { writeFileSync } from 'node:fs'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const key = process.env['CEREBRAS_API_KEY'] ?? ''
const model = process.env['CEREBRAS_MODEL'] ?? 'zai-glm-4.7'
const llm = {
  id: 'cerebras', label: 'Cerebras',
  isConfigured: () => true,
  async complete(req: { messages: { role: string; content: string }[]; maxTokens?: number | undefined; temperature?: number | undefined }) {
    const res = await fetch('https://api.cerebras.ai/v1/chat/completions', {
      method: 'POST',
      headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model, messages: req.messages, max_completion_tokens: req.maxTokens ?? 16000, temperature: req.temperature ?? 0.7 }),
    })
    if (!res.ok) throw new Error(`cerebras ${res.status}: ${(await res.text()).slice(0, 300)}`)
    const j = await res.json()
    return j.choices?.[0]?.message?.content ?? ''
  },
}

async function main() {
  const dir = mkdtempSync(join(tmpdir(), 'kernel-'))
  const store = new LocalWorldStore(fileStore(defaultStorePath({ STUDIO_HOME: dir })))
  const created = await store.createWorld({ premise: 'a beaver exploring Atlantis' }, 'probe')
  const id = created.worldId ?? ''
  console.log('world', id)
  const t0 = Date.now()
  const gkey = process.env['GEMINI_API_KEY'] ?? ''
  const image = {
    id: 'gemini', label: 'Nano Banana',
    isConfigured: () => gkey.length > 0,
    async generate(prompt: string) {
      const r = await fetch('https://generativelanguage.googleapis.com/v1beta/models/gemini-3-pro-image:generateContent', {
        method: 'POST', headers: { 'x-goog-api-key': gkey, 'Content-Type': 'application/json' },
        body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }], generationConfig: { responseModalities: ['IMAGE'], imageConfig: { aspectRatio: '16:9' } } }),
      })
      if (!r.ok) throw new Error(`gemini ${r.status}`)
      const j: any = await r.json()
      const part = j.candidates?.[0]?.content?.parts?.find((p: any) => p.inlineData)
      if (!part) throw new Error('no image part')
      return { b64: part.inlineData.data, mime: part.inlineData.mimeType }
    },
  }
  const mkey = process.env['MOONDREAM_API_KEY'] ?? ''
  const vision = {
    id: 'moondream', label: 'Moondream',
    isConfigured: () => mkey.length > 0,
    async detect(imageB64: string, object: string) {
      const r = await fetch('https://api.moondream.ai/v1/detect', {
        method: 'POST',
        headers: { Authorization: `Bearer ${mkey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ image_url: imageB64.startsWith('data:') ? imageB64 : `data:image/jpeg;base64,${imageB64}`, object, stream: false }),
      })
      if (!r.ok) throw new Error(`moondream ${r.status}`)
      const j: any = await r.json()
      const out = (j.objects ?? []).map((o: any) => ({ xMin: o.x_min, yMin: o.y_min, xMax: o.x_max, yMax: o.y_max }))
      console.log(`    probe "${object}" → ${out.length} hit(s)`)
      return out
    },
  }
  const res = await runGeneration({ llm, store, image, vision, worldId: id, premise: 'a beaver exploring Atlantis' })
  console.log('PROBED:', JSON.stringify(res.probed))
  console.log('NAME:', JSON.stringify(res.name), '| ANCHORED:', res.anchored)
  console.log(`\n=== ${res.states} states, ${res.events} events, ${res.rounds} round(s), ${Math.round((Date.now()-t0)/1000)}s ===`)
  console.log('reply:', res.reply)
  const scene = await store.getScene(id)
  console.log('\nSTATES:')
  for (const [sid, st] of Object.entries(scene.states)) {
    const ending = st.ending ? ` [${st.ending.kind}: ${st.ending.title}]` : ''
    console.log(` • ${sid}${ending} — ${String(st.base).slice(0, 100)}…  (${String(st.base).length} chars)`)
  }
  console.log('\nANCHORS (must be verified nouns):')
  for (const e of scene.events) if (e.anchor) console.log(`  ${e.name} → "${e.anchor.label}"${e.anchor.aliases?.length ? ' aliases: ' + e.anchor.aliases.join(', ') : ''}`)
  console.log('\nEVENTS:')
  for (const e of scene.events) console.log(` • ${e.name} (${e.kind}) ${e.from.join(',')}${e.to ? ' → ' + e.to : ''}`)
  const doc = await store.getWorld(id)
  const world = { ...(doc.world ?? doc), scene: { states: scene.states, events: scene.events } }
  const ent = world.entrance
  if (ent?.image?.src) {
    const b64 = ent.image.src.split(',')[1] ?? ''
    writeFileSync('evidence/beaver/oss-anchor.jpg', Buffer.from(b64, 'base64'))
    console.log('ANCHOR FRAME written:', Math.round(b64.length * 0.75 / 1024), 'KB from entrance', ent.state)
  }
  const doc2 = await store.getWorld(id)
  console.log('WORLD NAME in store:', JSON.stringify((doc2 as any).name))
  console.log('\nDOCTRINE:', runDoctrine(world).length, 'diagnostics')
  for (const d of runDoctrine(world)) console.log(`  [${d.severity}] ${d.lint} ${d.path}`)

}
main().catch((e) => { console.error(e); process.exit(1) })
