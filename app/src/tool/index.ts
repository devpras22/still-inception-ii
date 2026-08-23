/**
 * Tool — the one authored surface, compiled to many consumers.
 *
 * Every operation the studio can perform is a node in one tree. A node is a leaf
 * (executable, with declared parameters) or a branch (a namespace of children),
 * the same shape at every depth, so one generic dispatcher walks all of it. The
 * tree then compiles to the CLI, to the help a person reads, to the compact
 * projection an agent carries in a system prompt, and — once the app consumes it
 * — to the in-process calls the UI makes. None of those is maintained separately;
 * that is the whole point.
 *
 * Belongs here: the primitive (declare/resolve/dispatch), the in-process bridge
 * (runTool + its outcome envelope), the parameter schema, the help renderers
 * (the person-facing help and the compact agent projection), the in-app
 * Reference screen (the tree rendered live — the domain that owns the tree owns
 * its renderings), and the assembled `root` tree.
 * Belongs elsewhere: what a leaf DOES. A leaf receives an injected `ctx.store`
 * and calls it; the store, the world shapes and the provider config are owned by
 * their own domains. This domain knows how to invoke a tool, never what any tool
 * means. Only what an external caller actually consumes is exported — internal
 * helpers stay internal, so the face is the surface and not an inventory.
 *
 * Note on imports: a domain's `tools.ts` imports `defineTool` from `./define`
 * directly rather than through this barrel. `defineTool` is the framework builder
 * a domain uses to DECLARE its leaves — imported the way a library's builder is —
 * and routing it through this index (which also pulls in `root`, which pulls in
 * every domain's tools) would be a module cycle. `root.ts` is the composition
 * root of the tree and reaches the domain `tools.ts` files directly, the same way
 * `main.tsx` composes the app.
 */

export type { Param, Params, ParamType, Infer } from './schema'
export { ToolInputError, parseArgs, coerce, kebab, describeParam } from './schema'

export type { ToolContext, LeafTool, BranchTool, Tool } from './define'
export { defineTool, isLeaf, resolve, leaves, recover } from './define'

export { dispatch } from './dispatch'

export { renderHelp, renderCompact } from './help'

export { runTool } from './run'
export type { ToolOutcome, ToolFailure } from './run'

export { Reference } from './Reference'

export { root } from './root'
