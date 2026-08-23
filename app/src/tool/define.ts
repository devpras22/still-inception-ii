/**
 * The tool primitive: one authored tree, many consumers.
 *
 * Every operation the studio can perform is a node in one tree. A node is either
 * a leaf (executable, with declared parameters) or a branch (a namespace of
 * children). Same shape at every depth, so one generic dispatcher walks all of
 * it — no per-command argument parsing, no switch statements, no hand-written
 * router.
 *
 * The tree then compiles to every surface that needs it: the CLI, the help an
 * agent reads, the compact projection that fits in a system prompt, and the
 * in-process calls the app itself makes. None of those is maintained separately,
 * which is the entire point: a hand-written surface beside the tree is a second
 * source of truth, and the second source is always the one that goes stale.
 *
 * `kind` is not decoration. It is what lets a caller know whether an operation
 * reads or writes without running it, and it is what makes the CLI's recovery
 * behaviour safe: a mistyped command may be auto-corrected to a query, never to
 * a mutation.
 */

import { parseArgs, type Infer, type Params } from './schema'

/** Everything a tool needs from its environment, injected rather than imported. */
export interface ToolContext {
  /** The world store to operate against — browser-backed or file-backed. */
  store: import('../world').WorldStore
  /** Where the call came from, for surfaces that log or attribute. */
  origin: 'cli' | 'app' | 'agent'
  /** Machine-readable output requested. Set by the dispatcher, not by leaves. */
  json: boolean
  /**
   * Read a file's text, when the surface can. Injected ONLY by the CLI (it owns
   * a disk); the app has no such capability and a leaf that needs it errors in
   * prose. This is the seam that keeps `world.import` from static-importing
   * `node:fs` — which would drag Node into the browser bundle — while still
   * letting the terminal import a bundle from a path.
   */
  readTextFile?: (path: string) => Promise<string>
  /**
   * Import a stagecraft PROGRAM module and hand back what it exported. Injected
   * only by the CLI, which owns a disk and a module loader; the browser has
   * neither, and a leaf that needs it says so in prose rather than pretending.
   *
   * Separate from `readTextFile` on purpose: a program is CODE, not data. The
   * language's whole promise is that `tsc` and the doctrine check it before it
   * reaches anything, and that promise is only real if the module is imported
   * and compiled rather than parsed out of a string.
   */
  importModule?: (path: string) => Promise<Record<string, unknown>>
  /**
   * Say what is happening WHILE it happens. Injected per call by a surface that
   * can show it — the composer watching a world get built — and absent
   * everywhere else, exactly like the capabilities below.
   *
   * The reason it exists: authoring a world is paint → probe → author → check,
   * and it is a MINUTE of wall time. With one envelope at the end, every one of
   * those steps looked identical from outside ("Authoring the world…"), so the
   * expensive middle — a frame being painted, a detector verifying nouns — was
   * invisible, and a run that had silently skipped the probe looked exactly like
   * one that had done it. A stage line is not decoration; it is the only place
   * the pipeline's shape is visible to the person waiting for it.
   */
  progress?: (note: string) => void
  /**
   * The language model to author with, when the surface has one. Injected by
   * the app from the provider registry; ABSENT in the CLI, which has no
   * Settings to configure one — a leaf that needs it errors in prose naming
   * where a key goes. Same seam shape as `readTextFile`, for the same reason:
   * the tree must not import a capability that only one consumer can supply.
   */
  llm?: import('../provider').LLMProvider
  /**
   * The image model that paints a world's first frame, when the surface has
   * one. Same injected-seam shape as `llm`: the app supplies it from the
   * provider registry, the CLI has none, and a leaf that wants one degrades
   * rather than failing — a world without an anchor frame is still a world.
   */
  image?: import('../provider').ImageProvider
  /**
   * The vision model that verifies a candidate anchor label against a painted
   * frame before the author is ever offered it, when the surface has one.
   * Same injected-seam shape as `llm`/`image`: the app supplies it from the
   * provider registry, the CLI has none, and a generation with no vision axis
   * configured just authors ungrounded, exactly as it always did — a world
   * without a probe is still a world.
   */
  vision?: import('../provider').VisionProvider
}

export interface LeafTool<P extends Params = Params> {
  /**
   * One line, at most 120 characters, rendered in every listing. What this is
   * and why it exists. Enforced at definition time, because a summary that
   * wraps breaks the listing it exists to appear in.
   */
  summary: string
  /**
   * The full contract: observable behaviour, invariants that span parameters,
   * failure modes, and the judgment a caller has to apply. Never mechanism, and
   * never a restatement of the parameters — each parameter documents itself.
   */
  description: string
  kind: 'query' | 'mutation'
  params: P
  run(input: Infer<P>, ctx: ToolContext): Promise<unknown>
}

export interface BranchTool {
  summary: string
  description: string
  children: Record<string, Tool>
}

export type Tool = LeafTool | BranchTool

export function isLeaf(tool: Tool): tool is LeafTool {
  return 'run' in tool
}

const SUMMARY_MAX = 120

export function defineTool<P extends Params>(config: LeafTool<P>): LeafTool<P>
export function defineTool(config: BranchTool): BranchTool
export function defineTool(config: Tool): Tool {
  if (config.summary.includes('\n')) {
    throw new Error(`tool summary must be a single line: ${JSON.stringify(config.summary)}`)
  }
  if (config.summary.length > SUMMARY_MAX) {
    throw new Error(
      `tool summary must be at most ${SUMMARY_MAX} characters (got ${config.summary.length}): ${JSON.stringify(config.summary)}`,
    )
  }
  if (config.description.trim() === '') {
    throw new Error(`tool description must not be empty: ${JSON.stringify(config.summary)}`)
  }
  if (isLeaf(config)) {
    for (const [name, param] of Object.entries(config.params)) {
      if (param.describe.trim() === '') {
        throw new Error(`parameter "${name}" needs a describe: ${JSON.stringify(config.summary)}`)
      }
    }
  }
  return config
}

/** Walk a dotted path — `world.state.add` — to the node it names. */
export function resolve(tree: Tool, path: string): Tool | undefined {
  if (path === '') return tree
  let current: Tool = tree
  for (const segment of path.split('.')) {
    if (isLeaf(current)) return undefined
    const next = current.children[segment]
    if (!next) return undefined
    current = next
  }
  return current
}

/** Every leaf in the tree, with its dotted path. Used by help and by tests. */
export function leaves(tree: Tool, prefix = ''): { path: string; leaf: LeafTool }[] {
  if (isLeaf(tree)) return prefix === '' ? [] : [{ path: prefix, leaf: tree }]
  const out: { path: string; leaf: LeafTool }[] = []
  for (const [name, child] of Object.entries(tree.children)) {
    out.push(...leaves(child, prefix === '' ? name : `${prefix}.${name}`))
  }
  return out
}

/** Character-level distance, for suggesting what was probably meant. */
function distance(a: string, b: string): number {
  const rows = a.length + 1
  const cols = b.length + 1
  const d: number[] = new Array(rows * cols).fill(0)
  for (let i = 0; i < rows; i += 1) d[i * cols] = i
  for (let j = 0; j < cols; j += 1) d[j] = j
  for (let i = 1; i < rows; i += 1) {
    for (let j = 1; j < cols; j += 1) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1
      d[i * cols + j] = Math.min(
        (d[(i - 1) * cols + j] ?? 0) + 1,
        (d[i * cols + j - 1] ?? 0) + 1,
        (d[(i - 1) * cols + j - 1] ?? 0) + cost,
      )
    }
  }
  return d[rows * cols - 1] ?? 0
}

/**
 * Resolve a possibly-mistyped command.
 *
 * Forgiving on reads, strict on writes: a close match that resolves to a
 * `query` may be run automatically, because the worst case is wasted time. A
 * mutation is never guessed at — "did you mean" is the most a typo earns when
 * the answer could write to someone's worlds.
 */
export function recover(
  tree: Tool,
  path: string,
): { tool: Tool; path: string; corrected: boolean } | { suggestion?: string } {
  const exact = resolve(tree, path)
  if (exact) return { tool: exact, path, corrected: false }

  const candidates = leaves(tree).map((l) => l.path)
  let best: string | undefined
  let bestScore = Infinity
  for (const candidate of candidates) {
    const score = distance(path, candidate)
    if (score < bestScore) {
      bestScore = score
      best = candidate
    }
  }
  if (best === undefined || bestScore > Math.max(2, Math.floor(path.length / 3))) return {}

  const tool = resolve(tree, best)
  if (tool && isLeaf(tool) && tool.kind === 'query') return { tool, path: best, corrected: true }
  return { suggestion: best }
}

export { parseArgs }
export type { Params, Infer }
