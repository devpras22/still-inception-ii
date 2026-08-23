/**
 * STILL — marries each memory take with Ellen's line: loudnorm, last-frame
 * hold for slow reads, written back over the same name via a temp file.
 *
 *   npx tsx scripts/mux-clips.ts
 */
import { readFileSync, existsSync, rmSync, mkdtempSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { execFileSync } from 'node:child_process'
import { tmpdir } from 'node:os'

const HERE = dirname(fileURLToPath(import.meta.url))
const SPEC = JSON.parse(readFileSync(join(HERE, '..', 'spec', 'story.json'), 'utf8')) as {
  memories: { id: string }[]
}
const CLIPS = join(HERE, '..', '..', 'alakazam-studio', 'public', 'clips')

function sh(cmd: string): void {
  execFileSync('sh', ['-c', cmd], { stdio: ['ignore', 'ignore', 'inherit'] })
}

const tmp = mkdtempSync(join(tmpdir(), 'stillmux-'))
for (const { id } of SPEC.memories) {
  const take = join(CLIPS, `still_${id}.webm`)
  const voice = join(HERE, '..', 'voice', `${id}.mp3`)
  if (!existsSync(take) || !existsSync(voice)) { console.log(`SKIP still_${id}`); continue }
  const out = join(tmp, `still_${id}.webm`)
  sh(`ffmpeg -y -v error -i "${take}" -i "${voice}" -vf tpad=stop_mode=clone:stop_duration=5 -af "loudnorm=I=-16:TP=-1.5:LRA=11,apad=pad_dur=0.7" -c:v libvpx-vp9 -crf 33 -b:v 0 -c:a libopus -b:a 96k -shortest "${out}"`)
  sh(`mv "${out}" "${take}"`)
  const v = parseFloat(String(execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', voice])))
  const c = parseFloat(String(execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', take])))
  console.log(`still_${id} — clip ${c.toFixed(1)}s vs voice ${v.toFixed(1)}s ${c >= v ? 'ok' : 'TRUNCATED'}`)
}
rmSync(tmp, { recursive: true, force: true })
console.log('all memory clips muxed')
