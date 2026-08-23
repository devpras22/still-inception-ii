/**
 * Help surfaces, all compiled from the tree.
 *
 * The help IS the spec. A caller — a person at a terminal or an agent with no
 * access to this source — must be able to use a tool correctly from its help
 * alone. A rule that is not in the help does not exist for the caller.
 *
 * There are two audiences with incompatible budgets, so there are two
 * renderers. A person gets the full contract for the one thing they asked
 * about. An agent gets a deliberately lossy projection of the WHOLE tree that
 * fits in a system prompt, and drills in only when it needs to. Trying to serve
 * both from one rendering produces something too thin to act on and too long to
 * carry.
 */

import { isLeaf, leaves, type Tool } from './define'
import { describeParam, kebab } from './schema'

/** Full help for one node. What a person sees at `studio <path> --help`. */
export function renderHelp(path: string, tool: Tool): string {
  const lines: string[] = []
  const name = path === '' ? 'studio' : `studio ${path.replace(/\./g, ' ')}`
  lines.push('')
  lines.push(`${name} — ${tool.summary}`)

  // Only print the description when it adds something. A trivial tool should
  // not be padded out with a paragraph that repeats its own summary.
  if (tool.description.trim() !== tool.summary.trim()) {
    lines.push('')
    lines.push(tool.description.trim())
  }

  if (isLeaf(tool)) {
    const entries = Object.entries(tool.params)
    if (entries.length > 0) {
      lines.push('')
      lines.push('Options:')
      const rendered = entries.map(([n, p]) => [describeParam(n, p), p] as const)
      const width = Math.max(...rendered.map(([flag]) => flag.length))
      for (const [flag, param] of rendered) {
        lines.push(`  ${flag.padEnd(width)}  ${param.describe}`)
      }
    }
    lines.push('')
    lines.push(`This ${tool.kind === 'query' ? 'reads' : 'writes'}.`)
  } else {
    const children = Object.entries(tool.children)
    if (children.length > 0) {
      lines.push('')
      lines.push('Commands:')
      const width = Math.max(...children.map(([n]) => n.length))
      for (const [childName, child] of children) {
        lines.push(`  ${childName.padEnd(width)}  ${child.summary}`)
      }
      lines.push('')
      lines.push(`Run "${name} <command> --help" for the full contract.`)
    }
  }
  lines.push('')
  return lines.join('\n')
}

/**
 * The whole tree, compressed for a system prompt.
 *
 * Deliberately lossy: first sentence of each summary, flags inline, no
 * descriptions, no examples. The full definitions run several times this size,
 * and an agent that has to carry them all pays that cost on every turn for
 * information it needs on one.
 */
export function renderCompact(tree: Tool): string {
  const blocks = leaves(tree).map(({ path, leaf }) => {
    const flags = Object.entries(leaf.params)
      .map(([n, p]) => {
        const value = p.type === 'boolean' ? '' : p.type === 'enum' ? ` ${p.values?.join('|')}` : p.type === 'number' ? ' N' : p.type === 'json' ? ' JSON' : ' TEXT'
        const body = `--${kebab(n)}${value}`
        return p.required ? body : `[${body}]`
      })
      .join(' ')
    const head = `studio ${path.replace(/\./g, ' ')}${flags ? ' ' + flags : ''}`
    return `${head}\n  ${firstSentence(leaf.summary)}`
  })
  return `${blocks.join('\n\n')}\n\nRun any command with --help for the full contract.\n`
}

function firstSentence(text: string): string {
  const end = text.search(/[.!?](\s|$)/)
  return end === -1 ? text : text.slice(0, end + 1)
}

