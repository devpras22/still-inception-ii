#!/usr/bin/env node
/**
 * Screenshot harness — the proof-of-work every visual change ships with.
 *
 * WHY THIS EXISTS. "Looks right to me" from whoever wrote the change is not
 * evidence; a PNG of the actual running app, at a named URL state, in a named
 * theme, is. The studio already makes every view state addressable by URL
 * parameter (see src/studio/url-state.ts) specifically so a state can be driven
 * to headlessly rather than clicked to — this script is the other half of that
 * bet: point it at a query, get back a file, hand the file to whoever is
 * judging the change.
 *
 * before/after/verify are the three moments a change has proof-of-work for: a
 * shot of the state before touching it, one after, and one a reviewer (human or
 * agent) can re-run standalone to confirm the after shot still holds.
 *
 * READINESS, not a fixed sleep. A blind `waitForTimeout` either fires early —
 * capturing a spinner, which is a screenshot of nothing — or pads every run
 * with dead seconds that add up across a wave of shots. So this polls a ladder
 * of real conditions instead, each one a thing that is actually true once the
 * page is worth looking at, and refuses to produce a file once none of them
 * have become true within the time budget: a timeout here is a bug report
 * (which stage never settled), not a screenshot of a loading state mislabeled
 * as evidence.
 *
 * Zero new dependencies: `chromium` comes from `@playwright/test`, already a
 * dev dependency for the e2e and capture suites; flags are parsed with
 * node:util's `parseArgs`, already in the runtime this repo requires (Node 22).
 *
 * Usage:
 *   node scripts/shot.mjs --prefix verify --name api --state "?section=api"
 *   node scripts/shot.mjs --help
 */

import { parseArgs } from 'node:util'
import { mkdir } from 'node:fs/promises'
import { resolve, join } from 'node:path'
import { chromium } from '@playwright/test'

// ── The rubric ───────────────────────────────────────────────────────────────

/**
 * Eight named failure classes. Each `check` is the one-line test a reader —
 * human or model — applies to the produced image; none of it is mechanical, so
 * none of it belongs in code as a pixel-diff threshold. Printed from --help and
 * again after every successful run, because the rubric is only useful sitting
 * next to the evidence it judges, not filed somewhere a reader has to go find.
 */
export const RUBRIC = [
  {
    name: 'UNREADABLE-TEXT',
    check: 'Any text where foreground and background sit close enough in value that reading it takes effort or guesswork.',
  },
  {
    name: 'WRONG-THEME-ISLAND',
    check: "Any element still wearing the OTHER theme's colours — a dark card in the light shot, a light input in the dark one.",
  },
  {
    name: 'INVISIBLE-EDGE',
    check: 'A control or panel boundary that cannot be located by eye because its border or shadow has too little contrast against its neighbour.',
  },
  {
    name: 'EMPTY-RECTANGLE',
    check: 'A region that should hold content — image, canvas, list, chart — rendering instead as a bare box with nothing in it.',
  },
  {
    name: 'CLIPPED-CONTROL',
    check: 'Any button, label, or input whose content is cut off by its own container instead of wrapping, shrinking, or scrolling.',
  },
  {
    name: 'OVERLAP',
    check: 'Two elements occupying the same pixels when neither is meant to be layered — text over a button, a tooltip over its own trigger.',
  },
  {
    name: 'PHANTOM-STATE',
    check: 'The image shows a state the --state query did not ask for — a stale panel, a leftover modal, or the default view instead of the named one.',
  },
  {
    name: 'MOBILE-SQUEEZE',
    check: 'At a narrow viewport, content that should reflow instead overflows, scrolls sideways, or gets crushed unreadably.',
  },
]

function formatRubric() {
  return RUBRIC.map((r) => `  ${r.name}\n    ${r.check}`).join('\n\n')
}

function printRubric() {
  process.stdout.write(`\nRubric — apply all 8 to every image before calling it evidence:\n\n${formatRubric()}\n`)
}

// ── Flags ────────────────────────────────────────────────────────────────────

const THEMES = ['dark', 'light']
const PREFIXES = ['before', 'after', 'verify']

function printHelp() {
  process.stdout.write(`
shot.mjs — screenshot harness, the proof-of-work for a visual change

Usage:
  node scripts/shot.mjs --prefix <before|after|verify> --name <slug> [options]

Options:
  --state "<query>"    the URL query naming the app state, e.g. "?section=api"
                        or "?world=w_x&tab=versions"            (default: none — the home state)
  --theme dark|light|both   which theme(s) to shoot             (default: both)
  --viewport WxH        browser viewport                        (default: 1440x900)
  --prefix before|after|verify  which phase this shot documents  (required)
  --name <slug>         short name for the shot                  (required)
  --dir <subdir>         subdirectory under evidence/            (default: shots)
  --base <url>           origin the dev server is running on     (default: http://localhost:4321)
  --help                 print this help and the rubric, then exit

Output:
  evidence/<dir>/<prefix>-<name>--<theme>--<WxH>.png   (one file per theme shot)

The dev server must already be running (npm run dev) — this script only drives
a browser against it, it never starts one.
`)
  printRubric()
}

function parseFlags(argv) {
  const { values } = parseArgs({
    args: argv,
    options: {
      state: { type: 'string', default: '' },
      theme: { type: 'string', default: 'both' },
      viewport: { type: 'string', default: '1440x900' },
      prefix: { type: 'string' },
      name: { type: 'string' },
      dir: { type: 'string', default: 'shots' },
      base: { type: 'string', default: 'http://localhost:4321' },
      help: { type: 'boolean', default: false },
    },
    allowPositionals: false,
  })
  return values
}

/** Total validation up front: one message per problem, none of it discovered
 *  three stages into a browser session. Returns the problems found, if any. */
function validateFlags(values) {
  const problems = []
  if (!values.prefix || !PREFIXES.includes(values.prefix)) {
    problems.push(`--prefix is required and must be one of: ${PREFIXES.join(', ')}`)
  }
  if (!values.name) {
    problems.push('--name is required')
  }
  if (values.theme !== 'both' && !THEMES.includes(values.theme)) {
    problems.push(`--theme must be dark, light, or both`)
  }
  const viewport = parseViewport(values.viewport)
  if (!viewport) {
    problems.push(`--viewport must look like WxH, e.g. 1440x900 (got "${values.viewport}")`)
  }
  return problems
}

function parseViewport(spec) {
  const m = /^(\d+)x(\d+)$/i.exec(spec ?? '')
  if (!m) return null
  const width = Number(m[1])
  const height = Number(m[2])
  if (width <= 0 || height <= 0) return null
  return { width, height }
}

/** Merge the requested theme into the state query — `?theme=` always wins over
 *  the persisted choice, which is what makes a shot deterministic regardless of
 *  what a previous run left in this browser profile. See src/studio/url-state.ts. */
function buildQuery(stateArg, theme) {
  const raw = stateArg.startsWith('?') ? stateArg.slice(1) : stateArg
  const params = new URLSearchParams(raw)
  params.set('theme', theme)
  return params.toString()
}

// ── Readiness ladder ─────────────────────────────────────────────────────────
//
// Every predicate below runs INSIDE the page via page.evaluate, so each is a
// plain, self-contained function: no closing over anything from this module,
// because only its source text crosses into the browser.

function hasRootChild() {
  const root = document.getElementById('root')
  return !!root && root.children.length > 0
}

function fontsReady() {
  return document.fonts.ready.then(() => true)
}

function twoAnimationFrames() {
  return new Promise((resolve) => {
    requestAnimationFrame(() => requestAnimationFrame(() => resolve(true)))
  })
}

/** Every async panel in this app renders a `.spin` element while it waits —
 *  that is precisely what generic `networkidle` misses, since the network can
 *  go quiet while a spinner keeps animating on a promise nothing polls. */
function anySpinVisible() {
  const spins = document.querySelectorAll('.spin')
  for (const el of spins) {
    const box = el.getBoundingClientRect()
    if (box.width <= 0 || box.height <= 0) continue
    const style = getComputedStyle(el)
    if (style.visibility === 'hidden' || style.display === 'none') continue
    return true
  }
  return false
}

/** Only asked when the state names a `play=` session. A provider owns the mount
 *  node imperatively (see src/play/Player.tsx) and may hand it a <canvas> or a
 *  <video>; either counts once it has actually painted something, not merely
 *  once it exists in the DOM. The canvas case is drawn onto an offscreen 2D
 *  canvas rather than read directly, so this works whether the source canvas
 *  is 2D or WebGL. */
function canvasOrVideoPainted() {
  function canvasHasPixel(canvas) {
    try {
      const w = canvas.width || 0
      const h = canvas.height || 0
      if (w === 0 || h === 0) return false
      const off = document.createElement('canvas')
      off.width = w
      off.height = h
      const ctx = off.getContext('2d')
      if (!ctx) return false
      ctx.drawImage(canvas, 0, 0)
      const data = ctx.getImageData(0, 0, w, h).data
      for (let i = 3; i < data.length; i += 4) {
        if (data[i] !== 0) return true
      }
      return false
    } catch {
      return false // a tainted or zero-size canvas is not painted evidence either way
    }
  }
  for (const c of document.querySelectorAll('canvas')) {
    if (canvasHasPixel(c)) return true
  }
  for (const v of document.querySelectorAll('video')) {
    if (v.readyState >= 2) return true
  }
  return false
}

const STAGE = {
  ROOT: '#root has at least one element child',
  FONTS: 'document.fonts.ready resolved',
  SPIN: 'no .spin element visible on two consecutive polls, 250ms apart',
  FRAMES: 'two requestAnimationFrame ticks',
  PAINT: 'a canvas with a painted pixel, or a video at readyState >= 2 (play= state)',
}

class ReadinessTimeoutError extends Error {
  constructor(stage) {
    super(`readiness stage never settled: ${stage}`)
    this.stage = stage
  }
}

const POLL_INTERVAL_MS = 200
const SPIN_GAP_MS = 250

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms))
}

/** Poll `predicate` in the page until it is truthy or `deadline` passes. A
 *  mid-navigation evaluate can throw ("execution context destroyed") — that is
 *  not readiness either, so it counts as a miss and the poll continues. */
async function pollUntil(page, stage, predicate, deadline) {
  for (;;) {
    let ok = false
    try {
      ok = await page.evaluate(predicate)
    } catch {
      ok = false
    }
    if (ok) return
    if (Date.now() >= deadline) throw new ReadinessTimeoutError(stage)
    await sleep(Math.min(POLL_INTERVAL_MS, Math.max(0, deadline - Date.now())))
  }
}

/** Bound a one-shot page promise (fonts.ready, two rAF ticks) by the SAME
 *  overall deadline the polling stages use, so no single stage can spend the
 *  whole 30s budget alone. */
function raceDeadline(promise, deadline, stage) {
  return new Promise((resolvePromise, rejectPromise) => {
    let settled = false
    const timer = setTimeout(() => {
      if (settled) return
      settled = true
      rejectPromise(new ReadinessTimeoutError(stage))
    }, Math.max(0, deadline - Date.now()))
    promise.then(
      (value) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        resolvePromise(value)
      },
      (err) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        rejectPromise(err instanceof Error ? err : new Error(String(err)))
      },
    )
  })
}

/** Stage 3, literally: not "no spinner right now" (a spinner can vanish and
 *  reappear between two async steps) but no spinner on two separate looks a
 *  quarter-second apart. Reappearance between the two just restarts the wait. */
async function waitNoSpinnerTwice(page, stage, deadline) {
  for (;;) {
    if (Date.now() >= deadline) throw new ReadinessTimeoutError(stage)
    let first = true
    try {
      first = await page.evaluate(anySpinVisible)
    } catch {
      first = true
    }
    if (first) {
      await sleep(Math.min(POLL_INTERVAL_MS, Math.max(0, deadline - Date.now())))
      continue
    }
    if (Date.now() >= deadline) throw new ReadinessTimeoutError(stage)
    await sleep(SPIN_GAP_MS)
    if (Date.now() >= deadline) throw new ReadinessTimeoutError(stage)
    let second = true
    try {
      second = await page.evaluate(anySpinVisible)
    } catch {
      second = true
    }
    if (!second) return
  }
}

async function readinessLadder(page, stateQuery, deadline) {
  await pollUntil(page, STAGE.ROOT, hasRootChild, deadline)
  await raceDeadline(page.evaluate(fontsReady), deadline, STAGE.FONTS)
  await waitNoSpinnerTwice(page, STAGE.SPIN, deadline)
  await raceDeadline(page.evaluate(twoAnimationFrames), deadline, STAGE.FRAMES)
  if (stateQuery.includes('play=')) {
    await pollUntil(page, STAGE.PAINT, canvasOrVideoPainted, deadline)
  }
}

const LADDER_BUDGET_MS = 30_000

// ── Reachability ─────────────────────────────────────────────────────────────

async function isBaseReachable(base) {
  try {
    await fetch(base, { signal: AbortSignal.timeout(5000) })
    return true // any HTTP response — even a 404 — means something is listening
  } catch {
    return false
  }
}

// ── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  const argv = process.argv.slice(2)
  const values = parseFlags(argv)

  if (values.help) {
    printHelp()
    return
  }

  const problems = validateFlags(values)
  if (problems.length > 0) {
    for (const p of problems) process.stderr.write(`shot: ${p}\n`)
    process.stderr.write('shot: see --help\n')
    process.exitCode = 1
    return
  }

  const { width, height } = parseViewport(values.viewport)
  const themes = values.theme === 'both' ? THEMES : [values.theme]

  if (!(await isBaseReachable(values.base))) {
    process.stderr.write(
      `shot: cannot reach ${values.base} — the dev server must be running (npm run dev).\n`,
    )
    process.exitCode = 1
    return
  }

  const outDir = resolve(process.cwd(), 'evidence', values.dir)
  await mkdir(outDir, { recursive: true })

  const browser = await chromium.launch()
  const written = []
  try {
    for (const theme of themes) {
      const query = buildQuery(values.state, theme)
      const url = `${values.base}/?${query}`
      const context = await browser.newContext({ viewport: { width, height } })
      const page = await context.newPage()
      try {
        await page.goto(url, { waitUntil: 'domcontentloaded' })
        const deadline = Date.now() + LADDER_BUDGET_MS
        await readinessLadder(page, values.state, deadline)
        const fileName = `${values.prefix}-${values.name}--${theme}--${width}x${height}.png`
        const filePath = join(outDir, fileName)
        await page.screenshot({ path: filePath })
        written.push(filePath)
      } finally {
        await context.close()
      }
    }
  } catch (err) {
    await browser.close()
    if (err instanceof ReadinessTimeoutError) {
      process.stderr.write(
        `shot: readiness timeout after ${LADDER_BUDGET_MS / 1000}s — stage never settled: ${err.stage}\n`,
      )
    } else {
      process.stderr.write(`shot: ${err instanceof Error ? err.message : String(err)}\n`)
    }
    process.exitCode = 1
    return
  }
  await browser.close()

  process.stdout.write('\nshot: wrote\n')
  for (const f of written) process.stdout.write(`  ${f}\n`)
  printRubric()
}

main().catch((err) => {
  process.stderr.write(`shot: ${err instanceof Error ? err.message : String(err)}\n`)
  process.exitCode = 1
})
