/**
 * The tool surface, rendered as a screen.
 *
 * This walks the LIVE tree — the same `root` the CLI dispatches, the compact
 * projection summarizes, and the app's bridge runs — and renders every leaf with
 * its contract. Nothing here is authored separately: add a leaf and it appears
 * in the terminal, in the agent's system prompt, and on this page in the same
 * commit. A hand-written API reference beside the tree would be the second
 * source of truth that goes stale; this one cannot.
 *
 * It lives in the tool domain because the domain that owns the tree owns its
 * renderings. Read-only on purpose: the page states each contract, and the
 * places to exercise one are the app's own panels and the CLI.
 */

import { root } from './root'
import { leaves, type LeafTool } from './define'
import { describeParam } from './schema'
import { Pill } from '../theme'

/** The leaves, grouped by their top-level branch, in tree order. */
function grouped(): Map<string, { path: string; leaf: LeafTool }[]> {
  const groups = new Map<string, { path: string; leaf: LeafTool }[]>()
  for (const entry of leaves(root)) {
    const head = entry.path.split('.')[0] ?? entry.path
    const arr = groups.get(head) ?? []
    arr.push(entry)
    groups.set(head, arr)
  }
  return groups
}

export function Reference() {
  return (
    <div style={{ maxWidth: 860 }}>
      <h2 style={{ marginTop: 0 }}>API</h2>
      <p className="muted" style={{ marginTop: 4 }}>
        Everything the studio can do, as one tree of tools. The terminal (<code>npm run studio</code>),
        the agent's projection, and the app's own panels all run these exact operations — this page is
        rendered from the live tree, so it cannot disagree with any of them.
      </p>
      {[...grouped()].map(([group, items]) => (
        <section key={group} style={{ marginTop: 18 }}>
          <h3 style={{ marginBottom: 8 }}><code>{group}</code></h3>
          {items.map(({ path, leaf }) => (
            <LeafCard key={path} path={path} leaf={leaf} />
          ))}
        </section>
      ))}
    </div>
  )
}

function LeafCard({ path, leaf }: { path: string; leaf: LeafTool }) {
  const params = Object.entries(leaf.params)
  return (
    <div className="card" style={{ marginBottom: 10 }}>
      <div className="row" style={{ justifyContent: 'space-between', gap: 8 }}>
        <strong><code>{path.split('.').join(' ')}</code></strong>
        <Pill>{leaf.kind}</Pill>
      </div>
      <p style={{ margin: '6px 0 0' }}>{leaf.summary}</p>
      <p className="muted" style={{ margin: '6px 0 0', fontSize: 12 }}>{leaf.description}</p>
      {params.length > 0 && (
        <div style={{ marginTop: 8 }}>
          {params.map(([name, param]) => (
            <div key={name} className="row" style={{ gap: 8, alignItems: 'baseline', marginTop: 4 }}>
              <code style={{ flex: 'none' }}>{describeParam(name, param)}</code>
              <span className="muted" style={{ fontSize: 12 }}>{param.describe}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
