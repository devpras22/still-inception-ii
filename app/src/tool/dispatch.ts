/**
 * One generic dispatcher for the whole tree.
 *
 * The tree's shape IS the command shape, at every depth, so this walks it
 * without knowing anything about any particular command. There is no per-command
 * argument parsing and no router: adding a tool anywhere in the tree makes it
 * reachable here, with help, immediately.
 *
 * `--json` is handled once, at this level, which is why every tool gets
 * machine-readable output without a single leaf implementing it.
 */

import { isLeaf, parseArgs, recover, resolve, type Tool, type ToolContext } from './define'
import { renderHelp } from './help'

export interface DispatchResult {
  /** What the tool returned. Undefined when help was printed instead. */
  value?: unknown
  /** Text meant for a human — help, or a correction notice. */
  output?: string
  /** Non-zero means the process should exit non-zero. */
  code: number
}

const HELP_FLAGS = new Set(['--help', '-h', 'help'])

export async function dispatch(
  tree: Tool,
  argv: readonly string[],
  ctx: ToolContext,
): Promise<DispatchResult> {
  const json = argv.includes('--json')
  const args = argv.filter((a) => a !== '--json')

  // Walk as far down the tree as the leading words go.
  const path: string[] = []
  let node: Tool = tree
  let index = 0
  while (index < args.length) {
    const token = args[index]
    if (token === undefined || token.startsWith('-')) break
    if (isLeaf(node)) break
    const child = node.children[token]
    if (!child) break
    node = child
    path.push(token)
    index += 1
  }

  const rest = args.slice(index)

  // An unconsumed bare word at a branch is a command that does not exist.
  const stray = rest.find((a) => !a.startsWith('-'))
  if (!isLeaf(node) && stray !== undefined && !HELP_FLAGS.has(stray)) {
    const attempted = [...path, stray].join('.')
    const found = recover(tree, attempted)
    if ('tool' in found && found.corrected) {
      // Forgiving on reads only: this is a query, so running it costs nothing
      // worse than time. A mutation is never guessed at.
      const notice = `(interpreting as "${found.path.replace(/\./g, ' ')}")`
      try {
        const result = await dispatch(tree, [...found.path.split('.'), ...rest.filter((a) => a !== stray)], ctx)
        return { ...result, output: `${notice}\n${result.output ?? ''}` }
      } catch (e) {
        // The notice must survive a failing corrected run too — an agent that
        // never learns its typo was rewritten will retry the typo, not the fix.
        return { code: 1, output: `${notice}\n${e instanceof Error ? e.message : String(e)}\n` }
      }
    }
    const suggestion = 'suggestion' in found ? found.suggestion : undefined
    return {
      code: 1,
      output:
        `unknown command "${attempted.replace(/\./g, ' ')}"` +
        (suggestion ? `\n\nDid you mean "${suggestion.replace(/\./g, ' ')}"?\n` : '\n') +
        renderHelp(path.join('.'), node),
    }
  }

  if (!isLeaf(node) || rest.some((a) => HELP_FLAGS.has(a))) {
    return { code: 0, output: renderHelp(path.join('.'), node) }
  }

  const input = parseArgs(node.params, rest)
  // The input type is derived from the tool's own params, and parseArgs has just
  // validated against exactly those params — this is the one place the two meet.
  const value = await node.run(input as never, { ...ctx, json })
  return { code: 0, value }
}

export { resolve }
