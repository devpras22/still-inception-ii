import type { SMWorld } from '../world'

/** What's currently selected in the graph editor. */
export type EditorSelection =
  | { kind: 'state'; id: string }
  | { kind: 'event'; name: string }
  | null

/** Shared props every editor sub-panel (Inspector, AgentBar, LintPanel,
 *  VersionsPanel, VisionPanel) receives from GraphEditor. GraphEditor owns the
 *  world+rev+selection state and re-fetches on `reload()` after any write. */
export interface EditorPanelProps {
  worldId: string
  /** Current world (with `scene`). Re-fetched by GraphEditor after writes. */
  world: SMWorld
  /** Current ETag/rev for optimistic concurrency — pass as ifMatch on writes. */
  rev: string
  /** Re-fetch world+scene from /v1 and refresh rev. Call after any successful write. */
  reload: () => Promise<void>
  selected: EditorSelection
  select: (sel: EditorSelection) => void
  /** Transient toast (err=true for red). */
  toast: (msg: string, err?: boolean) => void
}
