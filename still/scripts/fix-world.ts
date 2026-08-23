/** STILL post-wire fixes: drop the blank `opening` state, positively rephrase
 *  the ending subtitle, save the world id. */
import { writeFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { fileStore, defaultStorePath } from '../../alakazam-studio/src/world/store/file.node'
import { LocalWorldStore } from '../../alakazam-studio/src/world/store/local'

const HERE = dirname(fileURLToPath(import.meta.url))
const WORLD_ID = 'w_mt5nh92neea951dd'

async function main(): Promise<void> {
  const store = new LocalWorldStore(fileStore(defaultStorePath()))
  const rev = (await store.getScene(WORLD_ID)).rev
  const result = await store.applyOps(WORLD_ID, [
    { op: 'remove_state', id: 'opening' },
    { op: 'set_state_ending', state: 'the_album', kind: 'win', title: 'STILL',
      subtitle: 'The people we love stay. They just stop moving. Tonight, they moved again.' },
  ], rev)
  console.log(`applied → rev ${result.rev}`)
  const verdict = await store.validate(WORLD_ID)
  const linted = await store.lint(WORLD_ID)
  console.log(`validate: ${verdict.ok ? 'OK' : 'FAILED'} · lint: ${linted.ok ? 'OK' : 'FAILED'}`)
  for (const d of [...verdict.diagnostics, ...linted.diagnostics]) console.log(`  [${d.severity}] ${d.lint}: ${d.message}`)
  if (!verdict.ok || !linted.ok) process.exit(1)
  writeFileSync(join(HERE, '..', 'spec', 'world-id.txt'), WORLD_ID)
  console.log('world id saved')
}

void main().catch((e: unknown) => { console.error(String(e)); process.exit(1) })
