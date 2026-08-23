/**
 * The README's terminal section is prose beside the tree — the one consumer of
 * the tool surface a compiler cannot regenerate. It has drifted once already
 * (it documented 5 leaves of a 30-leaf tree until a truth-sync caught it), so
 * this pins it the same way the Node version is pinned across its four files:
 * a fact stated in two places is a test, not a hope.
 *
 * The contract is deliberately loose: every segment of every leaf path must
 * APPEAR in the section (as a word), not match any particular layout. Adding or
 * renaming a leaf without touching the README trips it; rewording the prose
 * around the same vocabulary does not.
 *
 * Finding the section is its own hazard. It used to look for the literal
 * `## The studio from a terminal` and stop at the next `\n## `, which broke the
 * moment the README's headings gained anchors — and would have broken SILENTLY
 * in the other direction: a heading style whose terminator never matches leaves
 * `end === -1`, the "section" becomes the rest of the file, and a test that
 * searches the whole README for thirty common words passes no matter what. So
 * the boundaries are found by heading STRUCTURE, and asserted: the section must
 * exist and must not run to the end of the document.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

import { leaves } from '../../src/tool/define'
import { root } from '../../src/tool/root'

test('the README terminal section names every leaf in the shipped tree', () => {
  const readme = readFileSync(new URL('../../README.md', import.meta.url), 'utf8')
  const lines = readme.split('\n')
  const isHeading = (line: string): boolean => /^#{1,6}\s/.test(line)

  const from = lines.findIndex((line) => isHeading(line) && line.includes('The studio from a terminal'))
  assert.ok(from >= 0, 'the terminal section exists, under a heading naming it')
  const rest = lines.slice(from + 1).findIndex(isHeading)
  assert.ok(rest >= 0, 'the terminal section ends at a later heading rather than running to the end of the file')
  const section = lines.slice(from, from + 1 + rest).join('\n')

  const missing: string[] = []
  for (const { path } of leaves(root)) {
    for (const segment of path.split('.')) {
      if (!new RegExp(`\\b${segment}\\b`).test(section)) missing.push(`${path} (segment "${segment}")`)
    }
  }
  assert.deepEqual(missing, [], `leaves the README's terminal section never mentions: ${missing.join(', ')}`)
})
