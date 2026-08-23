#!/usr/bin/env -S npx tsx
/**
 * The studio, from a terminal.
 *
 * Runs the SAME tool tree the app uses, against the same world store through a
 * file-backed driver. A world authored here opens in the browser and vice versa,
 * because there is one implementation of what a world is and one set of
 * operations over it.
 *
 * Run through `tsx`, so there is no build step and no bundled copy between this
 * file and the studio's own modules. That matters more than it sounds: a
 * compiled CLI is a second artifact that can go stale, and a CLI running last
 * week's idea of what a world is would corrupt worlds rather than merely fail.
 */

import { pathToFileURL } from 'node:url'
import { resolve } from 'node:path'
import { readFile } from 'node:fs/promises'
import { LocalWorldStore } from '../src/world/store/local'
import { fileStore, defaultStorePath } from '../src/world/store/file.node'
import { root } from '../src/tool/root'
import { dispatch } from '../src/tool/dispatch'
import { renderCompact } from '../src/tool/help'

async function main(): Promise<void> {
  const argv = process.argv.slice(2)

  // The compact projection exists for system prompts: the whole surface, lossy,
  // in a fraction of the tokens the full help would cost.
  if (argv[0] === '--compact-help') {
    process.stdout.write(renderCompact(root))
    return
  }

  const path = defaultStorePath(process.env)
  const store = new LocalWorldStore(fileStore(path))

  // The CLI owns a disk, so it — and only it — injects the file-reading seam that
  // `world.import` reaches for. The app leaves it undefined and that leaf errors
  // in prose, which is why the tool tree never has to name `node:fs` itself.
  const result = await dispatch(root, argv, {
    store,
    origin: 'cli',
    json: false,
    readTextFile: (p) => readFile(p, 'utf8'),
    // The terminal is the surface that can run a program: `studio author
    // compile ./examples/walk-to-the-bench.sc.ts`. `tsx` is what makes
    // importing a TypeScript module here work at all (see package.json's bin).
    importModule: async (p) => {
      const url = pathToFileURL(resolve(p)).href
      // A module namespace IS a record of unknowns; saying so with a guard
      // keeps the one place that loads arbitrary code from needing a cast.
      const mod: unknown = await import(url)
      if (typeof mod !== 'object' || mod === null) {
        throw new Error(`${p} did not export a module object`)
      }
      return { ...mod }
    },
  })

  if (result.output !== undefined) process.stdout.write(result.output)
  if (result.value !== undefined) process.stdout.write(JSON.stringify(result.value, null, 2) + '\n')
  if (result.code !== 0) process.exitCode = result.code
}

main().catch((e: unknown) => {
  process.stderr.write(`${e instanceof Error ? e.message : String(e)}\n`)
  process.exitCode = 1
})
