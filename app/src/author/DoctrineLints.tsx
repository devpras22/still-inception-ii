import { useState } from 'react'
import type { EditorSelection } from './types'
import type { Diagnostic } from '../world'
import { canAutoFix, lintTitle, lintWhat } from '../world'
import { Button, Spacer } from '../theme'

/**
 * DoctrineLints — the floating doctrine-lints panel this editor was missing:
 * a bottom-left panel that floats over the canvas (`<Panel position="bottom-left">`
 * hosting `.lintPanel`).
 * `GraphEditor` runs `runDoctrine` once (memoised on the world) and hands the
 * result here AND into `GraphCanvas`'s `diagnostics` prop, so the same list
 * colours nodes/edges and fills this panel — one doctrine, two views of it,
 * never a second source of truth.
 *
 * A clean world renders nothing at all, not an empty box — matching this
 * repo's own convention for a satisfied gate (see `Lint.tsx`'s "clean by
 * doctrine" being TEXT, never a component that exists to say nothing).
 *
 * Rows speak to a CREATOR, not to a compiler. The headline is the rule's plain
 * title and "what's this?" opens what it means and how to fix it
 * (`world/lintHelp.ts`); the raw code stays, small, for anyone who wants to
 * look the rule up. It used to expand to nothing BUT the raw code, which is
 * the same problem wearing a disclosure triangle.
 *
 * Where a fix is deterministic and non-destructive there is a Fix button, and
 * only there: anything needing a human decision — rewriting prose, choosing a
 * destination state — deliberately has none, because a button that guesses at
 * an author's intent is worse than a sentence telling them what to do.
 *
 * Row click routes through the SAME `onSelect` (→ `GraphEditor`'s `select` →
 * `onNavigate`) every other selection in this editor uses, so a lint takes
 * the author to the exact node/event through the URL like any other view
 * state — not a private jump the back button does not know about.
 */
export function DoctrineLints({
  diagnostics,
  onSelect,
  onFix,
  fixing,
}: {
  diagnostics: Diagnostic[]
  onSelect: (sel: EditorSelection) => void
  /** Applies a lint's safe auto-fix through the same op path every other write
   *  in this editor uses. Absent = no Fix buttons (a read-only host). */
  onFix?: ((d: Diagnostic) => void) | undefined
  /** The lint currently being fixed, so its button can say so. */
  fixing?: string | null | undefined
}) {
  const [collapsed, setCollapsed] = useState(false)
  // Which rows have their "what's this?" (the lint's rule id) expanded —
  // keyed by the same identity DiagList/Diags use elsewhere in this domain.
  const [expanded, setExpanded] = useState<Set<string>>(new Set())

  if (diagnostics.length === 0) return null

  function toggleExpanded(key: string): void {
    setExpanded((prev) => {
      const next = new Set(prev)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      return next
    })
  }

  return (
    <div className="lint-panel">
      <Button
        className="lint-panel-head"
        onClick={() => setCollapsed((c) => !c)}
        aria-expanded={!collapsed}
      >
        <span>DOCTRINE LINTS</span>
        <span className="lint-panel-count">{diagnostics.length}</span>
        <Spacer />
        <span aria-hidden="true">{collapsed ? '▸' : '▾'}</span>
      </Button>
      {!collapsed && (
        <div className="lint-panel-body">
          {diagnostics.map((d, i) => {
            const key = `${d.lint}:${d.path}:${i}`
            const target = pathToSelection(d.path)
            return (
              <div
                key={key}
                className="lint-row"
                role="button"
                tabIndex={0}
                aria-label={`${severityLabel(d.severity)}: ${d.message}`}
                onClick={() => target && onSelect(target)}
                onKeyDown={(e) => {
                  if ((e.key === 'Enter' || e.key === ' ') && target) {
                    e.preventDefault()
                    onSelect(target)
                  }
                }}
              >
                <span className={`lint-chip lint-chip-${d.severity}`}>{severityLabel(d.severity)}</span>
                <span className="lint-msg">{lintTitle(d.lint)}</span>
                <Button
                  variant="ghost"
                  className="lint-whats"
                  text="what's this?"
                  onClick={(e) => {
                    e.stopPropagation()
                    toggleExpanded(key)
                  }}
                />
                {onFix && canAutoFix(d) && (
                  <Button
                    className="lint-fix"
                    disabled={fixing === key}
                    text={fixing === key ? '…' : 'Fix'}
                    title="apply the safe default for this rule"
                    onClick={(e) => {
                      e.stopPropagation()
                      onFix(d)
                    }}
                  />
                )}
                <span className="lint-path">{d.path}</span>
                {expanded.has(key) && (
                  <div className="lint-what">
                    {lintWhat(d.lint)}
                    {/* The doctrine's own sentence, kept: the title says what
                        is wrong, this says exactly WHERE and with what text. */}
                    <div className="lint-detail">{d.message}</div>
                    <div className="lint-rule">[{d.lint}]</div>
                  </div>
                )}
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}

function severityLabel(severity: Diagnostic['severity']): string {
  switch (severity) {
    case 'error':
      return 'MUST FIX'
    case 'warning':
      return 'WARNING'
    case 'info':
      return 'NOTE'
  }
}

/**
 * `states.<id>...` / `events.<name>...` → what the row should select on
 * click, reading the exact same path convention `../world/doctrine.ts` and
 * `GraphCanvas.tsx`'s `bucketDiagnostics` already agree on. A world-level path
 * (`entrance`, `scene.states`) names no single node/event, so it resolves to
 * `null` — the row still renders (the diagnostic is real), it just does not
 * pretend a click can land somewhere specific.
 */
function pathToSelection(path: string): EditorSelection {
  const stateId = /^states\.([^.]+)/.exec(path)?.[1]
  if (stateId !== undefined) return { kind: 'state', id: stateId }
  const eventName = /^events\.([^.]+)/.exec(path)?.[1]
  if (eventName !== undefined) return { kind: 'event', name: eventName }
  return null
}
