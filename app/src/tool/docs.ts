/**
 * Docs — the studio's own domain map, read from its own source.
 *
 * An agent driving the CLI has no editor open beside it and no way to browse the
 * repository; the only way it learns what a domain owns is to be told, in prose
 * it can ask for on demand. Every domain already carries that prose — the
 * "Belongs here / Belongs elsewhere" contract `require-public-face` requires at
 * the top of its public face — so this leaf does not maintain a second copy of
 * it. It reads the same doc comment a person would open the file to see and
 * hands it back verbatim, one entry per domain, plus the tool tree's own.
 */

import { defineTool } from './define'
import type { ToolContext } from './define'

/**
 * The seven domain faces `scripts/check-conventions.mjs` walks, in the order it
 * lists them, plus the tool tree's own face last — eight sources, eight
 * contracts. A face is `index.ts` for every domain but one; `theme`'s is
 * `index.tsx` (it exports JSX), which is why this tries the source extension
 * first and falls back to the JSX one rather than hard-coding either.
 */
const DOMAINS = ['account', 'author', 'play', 'provider', 'studio', 'theme', 'world', 'tool']

/** Read a domain's public face, trying `index.ts` then `index.tsx`. */
async function readFace(read: (path: string) => Promise<string>, name: string): Promise<string> {
  const base = `src/${name}/index`
  try {
    return await read(`${base}.ts`)
  } catch (tsError) {
    try {
      return await read(`${base}.tsx`)
    } catch {
      throw tsError
    }
  }
}

/** Strip a leading `/** ... *\/` block down to its prose — no comment markers,
 *  no per-line indentation — the way it reads to someone who opened the file. */
function extractContract(source: string): string {
  const match = /^\s*\/\*\*([\s\S]*?)\*\//.exec(source)
  if (!match) return ''
  return (match[1] ?? '')
    .split('\n')
    .map((line) => line.replace(/^\s*\*\s?/, ''))
    .join('\n')
    .trim()
}

export const docsTool = defineTool({
  summary: 'The domain map: what each part of the studio owns, read from the source itself.',
  description:
    'Reads the leading doc comment off each domain\'s public face — the same "Belongs here / ' +
    'Belongs elsewhere" contract a person sees on opening the file — and returns it verbatim, ' +
    'domain by domain, plus the tool tree\'s own. There is no separate map maintained anywhere: ' +
    "this IS the source, read live, so it cannot drift the way a written-up architecture doc would. " +
    'Paths resolve relative to the process\'s current working directory, so this only works run from ' +
    'the repo root — which is how the CLI is invoked, and the reason this leaf reaches for the same ' +
    "file-reading seam `world import --file` uses: the app has no filesystem to read from, so there " +
    "it errors rather than guessing.",
  kind: 'query',
  params: {},
  async run(_input, ctx: ToolContext) {
    const read = ctx.readTextFile
    if (!read) throw new Error('reading the studio\'s own source needs a filesystem, which only the CLI has')
    const domains: { name: string; contract: string }[] = []
    for (const name of DOMAINS) {
      const source = await readFace(read, name)
      domains.push({ name, contract: extractContract(source) })
    }
    return { domains }
  },
})
