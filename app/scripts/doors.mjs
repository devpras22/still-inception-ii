#!/usr/bin/env node
/**
 * Which authoring capabilities can a person actually REACH?
 *
 * The DONE criterion here is "an author can reach it and a player can
 * feel it", and the parity table has no column for the first half: three rows
 * in a row named their capability correctly and omitted whether anyone could
 * start it (iterations 129-130). Two real gaps had been sitting behind that —
 * book→campaign and frame→quest each worked from the CLI and the agent tree
 * with no door in the studio, while 298 unit tests and 65 e2e passed over them.
 * Tests check that a thing works, never that a person can reach it.
 *
 * A REPORT, deliberately, not a gate. Which leaves deserve a UI door is a
 * judgement: `world.version.*` is reached through the Versions panel calling
 * the store directly, `author.validate` through the Lint panel, and a hard rule
 * would fail on both. So this prints what it finds and leaves the reading to a
 * person — the same call `no-dead-exports` makes when it counts tests as
 * consumers on purpose.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'

const files = []
;(function walk(d) {
  for (const e of readdirSync(d)) {
    const p = join(d, e)
    if (statSync(p).isDirectory()) walk(p)
    else if (/\.tsx?$/.test(p)) files.push({ path: p, text: readFileSync(p, 'utf8') })
  }
})('src')

// The tool tree is the authored surface; anything else that names a leaf is a
// consumer. `tools.ts` files DEFINE leaves, so they are never a door.
const isDefinition = (p) => /\/tools\.ts$/.test(p) || /\/tool\//.test(p)
const leaves = new Set()
for (const f of files) {
  if (!/\/tools\.ts$/.test(f.path)) continue
  const domain = f.path.replace(/^src\//, '').replace(/\/tools\.ts$/, '')
  for (const m of f.text.matchAll(/^\s{4}([a-z][\w]*): defineTool\(/gm)) leaves.add(`${domain}.${m[1]}`)
}

// THE SECOND DOOR SHAPE. A panel can reach a capability without naming its leaf,
// by calling the store method underneath it — the Lint panel calls
// `store.validate`/`store.lint`, the Versions panel `store.listVersions`. The
// first version of this report called both "no door", which is the difference
// between "unreachable" and "reached another way" and exactly the blind spot it
// printed about itself.
//
// HEURISTIC, and named as one in the output: a leaf's last segment prefixing a
// store method (`world.diff` → `store.diffVersions`). It can miss a method named
// nothing like its leaf, so a "no door" line stays a question rather than a verdict.
const storeCalls = new Map()
for (const f of files) {
  if (isDefinition(f.path)) continue
  for (const m of f.text.matchAll(/\bstore\.([a-zA-Z]\w*)\s*\(/g)) {
    const method = m[1]
    storeCalls.set(method, [...(storeCalls.get(method) ?? new Set([])), f.path.replace(/^src\//, '')])
  }
}

const rows = []
for (const leaf of [...leaves].sort()) {
  const doors = files
    .filter((f) => !isDefinition(f.path) && f.text.includes(`'${leaf}'`))
    .map((f) => f.path.replace(/^src\//, ''))
  let via = []
  // The store belongs to `world/`, and `author/` leaves operate on worlds
  // through it. A leaf from any other domain matching a store method is a
  // coincidence of naming, not a door: `provider.list` matched
  // `store.listVersions` on the first run purely because both start with "list".
  const domain = leaf.split('.')[0]
  if (doors.length === 0 && (domain === 'world' || domain === 'author')) {
    const last = leaf.split('.').pop() ?? ''
    for (const [method, where] of storeCalls) {
      if (method.toLowerCase().startsWith(last.toLowerCase())) {
        via.push(`store.${method} in ${[...new Set(where)].join(', ')}`)
      }
    }
  }
  rows.push({ leaf, doors, via })
}

const width = Math.max(...rows.map((r) => r.leaf.length))
let missing = 0
let indirect = 0
for (const { leaf, doors, via } of rows) {
  if (doors.length > 0) {
    console.log(`  reached   ${leaf.padEnd(width)}  ${doors.join(', ')}`)
  } else if (via.length > 0) {
    indirect += 1
    console.log(`  via store ${leaf.padEnd(width)}  ${via.join(', ')}`)
  } else {
    missing += 1
    console.log(`  no door   ${leaf.padEnd(width)}  — CLI and agent only`)
  }
}
console.log(`\n${rows.length} leaves · ${rows.length - missing - indirect} reached by leaf · ${indirect} reached through the store · ${missing} CLI/agent only`)
console.log('A leaf with no door is not automatically a defect: some are meant for the terminal.')
console.log('"via store" is a HEURISTIC — a leaf\'s last segment prefixing a store method — so')
console.log('read the named method before trusting it, and read a "no door" line as a question.')
