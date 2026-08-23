import { useEffect, useMemo, useRef, useState } from 'react'
import type { EditorSelection } from './types'
import type { Diagnostic, SMEvent, SMState } from '../world'

/**
 * GraphCanvas — the SVG rendering of a world graph: layout, node/edge
 * drawing, click-to-select hit-testing, and camera pan/zoom. It owns drawing
 * only: no store access, no writes. Props (states/events/entrance/selected/
 * diagnostics) come in, selection events (`onSelect`) go out — GraphEditor is
 * the one that turns those into writes.
 *
 * A real layered ("Sugiyama-lite") left-to-right layout instead of a
 * decorative circle, a 280x168 card per state with a lint badge and in-card
 * override/ending chips instead of a bare labelled box, quadratic edges with
 * fan/bow/loop routing and lint-driven colour instead of straight grey
 * lines, and background-drag pan + wheel zoom now that a real graph exceeds
 * the pane.
 *
 * Built against this repo's own SMState/SMEvent shapes (`../world`): there
 * is no `cutscenes`/`sequences` field here, and "ending" is a property of
 * the STATE (`state.ending`) rather than a `terminal`-kind event with no
 * `to` — so both get their own visual: a red ENDING chip for the former, and
 * either a red-dashed EDGE (a terminal event that names a real `to`) or a
 * red chip alongside the cyan override chips (a terminal event with no
 * destination) for the latter.
 */

// ── Layout constants ──────────────────────────────────────────────────────
const NODE_W = 280
const NODE_H = 168
const COL_W = 440
const ROW_H = 250
const ORIGIN_X = NODE_W / 2 + 40
const ORIGIN_Y = NODE_H / 2 + 40

// ── Edge routing constants ───────────────────────────────────────────────
const GAP = 46
const BACK_BOW = 60
const SELF_R = 72

const MIN_ZOOM = 0.2
const MAX_ZOOM = 2.5

interface XY {
  x: number
  y: number
}

function clamp(v: number, min: number, max: number): number {
  return Math.min(Math.max(v, min), max)
}

function trunc(s: string, n = 16): string {
  return s.length > n ? s.slice(0, n - 1) + '…' : s
}

/** Monospace glyphs run close to a fixed fraction of their font size — good
 *  enough to size a pill/chip/label box without a canvas measurement pass. */
function approxTextWidth(s: string, fontSize: number): number {
  return s.length * fontSize * 0.62
}

/** Word-wrap an already-clamped string into up to `maxLines` lines, each at
 *  most `maxCharsPerLine` — SVG `<text>` does not wrap on its own. */
function wrapToLines(s: string, maxCharsPerLine: number, maxLines: number): string[] {
  const words = s.split(/\s+/).filter((w) => w.length > 0)
  const lines: string[] = []
  let cur = ''
  for (const w of words) {
    const next = cur ? `${cur} ${w}` : w
    if (next.length > maxCharsPerLine && cur) {
      lines.push(cur)
      if (lines.length === maxLines) return lines
      cur = w
    } else {
      cur = next
    }
  }
  if (cur) lines.push(cur)
  return lines.slice(0, maxLines)
}

/** Unordered pair key — the same key for A→B and B→A — so a parallel or
 *  bidirectional pair shares one fan-out count, and every self-loop on a
 *  state (from === to) keys against its own running index. */
function pairKey(a: string, b: string): string {
  return a < b ? `${a}\u0000${b}` : `${b}\u0000${a}`
}

/** The bijection: an event is an EDGE only when its `to` resolves to a real
 *  state, regardless of `kind` — a `transition` or a `terminal` event both
 *  qualify. An `override`, or a `terminal` with no destination, is drawn as
 *  a chip on the card instead. A `to` that names a CUTSCENE resolves through
 *  it to the state the cut lands in — the same first-resolution the runtime
 *  does — or a choice film whose every branch plays a clip draws as a pile
 *  of disconnected cards. */
function edgeTarget(
  ev: SMEvent,
  states: Record<string, SMState>,
  cutById: Map<string, { to: string }>,
): string | undefined {
  if (ev.to === undefined) return undefined
  const cut = cutById.get(ev.to)
  const dest = cut ? cut.to : ev.to
  return dest in states ? dest : undefined
}

interface RawEdge {
  name: string
  kind: SMEvent['kind']
  from: string
  to: string
}

function collectEdges(
  states: Record<string, SMState>,
  events: SMEvent[],
  cutscenes: readonly { id: string; to: string }[] = [],
): RawEdge[] {
  const cutById = new Map(cutscenes.map((c) => [c.id, c]))
  const out: RawEdge[] = []
  for (const ev of events) {
    const to = edgeTarget(ev, states, cutById)
    if (to === undefined) continue
    for (const from of ev.from) {
      if (from in states) out.push({ name: ev.name, kind: ev.kind, from, to })
    }
  }
  return out
}

interface LayoutResult {
  pos: Map<string, XY>
  rank: Map<string, number>
}

/**
 * Sugiyama-lite layered layout: break cycles by DFS from the entrance, rank
 * by longest path (Kahn topo-sort + relax), park anything unreachable in one
 * trailing column, order within each column via six alternating barycenter
 * sweeps, place on a COL_W x ROW_H grid with every column vertically
 * centred on a shared spine.
 */
function autoLayout(ids: string[], edges: RawEdge[], entrance: string | undefined): LayoutResult {
  const pos = new Map<string, XY>()
  const rank = new Map<string, number>()
  if (ids.length === 0) return { pos, rank }

  const fallbackStart = ids[0]
  const start = entrance !== undefined && ids.includes(entrance) ? entrance : fallbackStart
  // ids.length > 0 already guarantees this; the type checker cannot narrow
  // an indexed access from a length check, so the guard stays explicit.
  if (start === undefined) return { pos, rank }

  // Every (from,to) pair, any kind, self-loops excluded — feeds the DFS
  // cycle break, the reachability walk, and the barycenter ordering below.
  const succ = new Map<string, string[]>()
  for (const e of edges) {
    if (e.from === e.to) continue
    const list = succ.get(e.from)
    if (list) list.push(e.to)
    else succ.set(e.from, [e.to])
  }

  // 1. Break cycles: white/gray/black DFS from the entrance. An edge into a
  //    GRAY node is a back-edge, excluded from the ranking DAG below.
  const WHITE = 0
  const GRAY = 1
  const BLACK = 2
  const color = new Map<string, number>(ids.map((id) => [id, WHITE]))
  const back = new Set<string>()
  function dfs(u: string): void {
    color.set(u, GRAY)
    for (const v of succ.get(u) ?? []) {
      const c = color.get(v)
      if (c === GRAY) back.add(`${u} ${v}`)
      else if (c === WHITE) dfs(v)
    }
    color.set(u, BLACK)
  }
  dfs(start)

  // 2. Rank via Kahn topo-sort + longest-path relax over the cycle-free DAG.
  const fwd = new Map<string, string[]>()
  for (const e of edges) {
    if (e.from === e.to) continue
    if (back.has(`${e.from} ${e.to}`)) continue
    const list = fwd.get(e.from)
    if (list) list.push(e.to)
    else fwd.set(e.from, [e.to])
  }
  const indeg = new Map<string, number>(ids.map((id) => [id, 0]))
  for (const list of fwd.values()) {
    for (const v of list) indeg.set(v, (indeg.get(v) ?? 0) + 1)
  }
  for (const id of ids) rank.set(id, 0)
  const queue = ids.filter((id) => (indeg.get(id) ?? 0) === 0)
  const topo: string[] = []
  for (let u = queue.shift(); u !== undefined; u = queue.shift()) {
    topo.push(u)
    for (const v of fwd.get(u) ?? []) {
      const d = (indeg.get(v) ?? 0) - 1
      indeg.set(v, d)
      if (d === 0) queue.push(v)
    }
  }
  for (const u of topo) {
    for (const v of fwd.get(u) ?? []) {
      rank.set(v, Math.max(rank.get(v) ?? 0, (rank.get(u) ?? 0) + 1))
    }
  }
  rank.set(start, 0) // the entrance always anchors column 0

  // 3. Reachability from the entrance over ANY edge (a cycle still counts as
  //    reachable). Anything not reached is parked in one trailing column of
  //    its own, past every ranked column.
  const reach = new Set<string>([start])
  const rstack = [start]
  for (let u = rstack.pop(); u !== undefined; u = rstack.pop()) {
    for (const v of succ.get(u) ?? []) {
      if (!reach.has(v)) {
        reach.add(v)
        rstack.push(v)
      }
    }
  }
  let maxRank = 0
  for (const id of ids) {
    if (reach.has(id)) maxRank = Math.max(maxRank, rank.get(id) ?? 0)
  }
  for (const id of ids) {
    if (!reach.has(id)) rank.set(id, maxRank + 1)
  }

  // 4. Order within each rank: seed via BFS visiting order from the
  //    entrance, then six alternating barycenter sweeps to cut crossings.
  const columns = new Map<number, string[]>()
  const seedOrder: string[] = []
  const seen = new Set<string>([start])
  const bqueue = [start]
  for (let u = bqueue.shift(); u !== undefined; u = bqueue.shift()) {
    seedOrder.push(u)
    for (const v of succ.get(u) ?? []) {
      if (!seen.has(v)) {
        seen.add(v)
        bqueue.push(v)
      }
    }
  }
  for (const id of ids) {
    if (!seen.has(id)) seedOrder.push(id)
  }
  for (const id of seedOrder) {
    const r = rank.get(id) ?? 0
    const col = columns.get(r)
    if (col) col.push(id)
    else columns.set(r, [id])
  }

  const preds = new Map<string, string[]>()
  for (const e of edges) {
    const list = preds.get(e.to)
    if (list) list.push(e.from)
    else preds.set(e.to, [e.from])
  }

  const ranks = [...columns.keys()].sort((a, b) => a - b)
  function barycenterOrder(colIds: string[], neighborsOf: Map<string, string[]>, refPos: Map<string, number>): string[] {
    return colIds
      .map((id, i) => {
        const ns = (neighborsOf.get(id) ?? [])
          .map((n) => refPos.get(n))
          .filter((n): n is number => n !== undefined)
        const score = ns.length > 0 ? ns.reduce((sum, v) => sum + v, 0) / ns.length : i
        return { id, score, i }
      })
      .sort((a, b) => a.score - b.score || a.i - b.i)
      .map((s) => s.id)
  }
  for (let sweep = 0; sweep < 6; sweep++) {
    const down = sweep % 2 === 0
    const order = down ? ranks : [...ranks].reverse()
    for (const r of order) {
      const col = columns.get(r)
      if (!col) continue
      const neighborRank = down ? r - 1 : r + 1
      const neighborCol = columns.get(neighborRank)
      if (!neighborCol) continue
      const refPos = new Map<string, number>(neighborCol.map((id, i) => [id, i]))
      columns.set(r, barycenterOrder(col, down ? preds : succ, refPos))
    }
  }

  // 5. Place on the grid, every column vertically centred on a shared spine.
  let maxCount = 1
  for (const col of columns.values()) maxCount = Math.max(maxCount, col.length)
  for (const r of ranks) {
    const col = columns.get(r) ?? []
    const padTop = (maxCount - col.length) / 2
    col.forEach((id, i) => {
      pos.set(id, { x: ORIGIN_X + r * COL_W, y: ORIGIN_Y + (i + padTop) * ROW_H })
    })
  }

  return { pos, rank }
}

interface DiagnosticBuckets {
  byState: Map<string, Diagnostic[]>
  byEvent: Map<string, Diagnostic[]>
}

/** Buckets doctrine hits by the state/event they name, reading the local
 *  doctrine's own path convention (`../world/doctrine.ts`: `states.<id>...`,
 *  `events.<name>...`) — a prefix match, not a full parse, matching the
 *  looseness every other reader of a Diagnostic's `path` already accepts. */
function bucketDiagnostics(diagnostics: Diagnostic[]): DiagnosticBuckets {
  const byState = new Map<string, Diagnostic[]>()
  const byEvent = new Map<string, Diagnostic[]>()
  for (const d of diagnostics) {
    const stateId = /^states\.([^.]+)/.exec(d.path)?.[1]
    if (stateId !== undefined) {
      const list = byState.get(stateId)
      if (list) list.push(d)
      else byState.set(stateId, [d])
      continue
    }
    const eventName = /^events\.([^.]+)/.exec(d.path)?.[1]
    if (eventName !== undefined) {
      const list = byEvent.get(eventName)
      if (list) list.push(d)
      else byEvent.set(eventName, [d])
    }
  }
  return { byState, byEvent }
}

function severityCounts(diags: Diagnostic[]): { errors: number; warnings: number } {
  let errors = 0
  let warnings = 0
  for (const d of diags) {
    if (d.severity === 'error') errors++
    else if (d.severity === 'warning') warnings++
  }
  return { errors, warnings }
}

/** Where a ray from `center` toward `target` exits the axis-aligned card
 *  (half-width/half-height `hw`/`hh`), plus a small `gap` beyond it so the
 *  stroke — and the arrowhead on it — visibly clears the card border. */
function shortenToRect(center: XY, target: XY, hw: number, hh: number, gap: number): XY {
  const dx = target.x - center.x
  const dy = target.y - center.y
  if (dx === 0 && dy === 0) return center
  const scaleX = dx !== 0 ? hw / Math.abs(dx) : Infinity
  const scaleY = dy !== 0 ? hh / Math.abs(dy) : Infinity
  const scale = Math.min(scaleX, scaleY)
  const len = Math.hypot(dx, dy) || 1
  return { x: center.x + dx * scale + (dx / len) * gap, y: center.y + dy * scale + (dy / len) * gap }
}

// ── In-card chips: cam/move/ambient/ending info, and the cyan override /
// red terminal ability row ───────────────────────────────────────────────

type ChipTone = 'info' | 'endingOutline' | 'cyan' | 'terminal'

interface ChipSpec {
  key: string
  label: string
  /**
   * The accessible name, when the visible label is not unique on the canvas.
   *
   * An override or a terminal fires from EVERY state it lists in `from`, so it
   * gets one chip per state — and all of them were announced as
   * "event listen, button". Two controls with one name is a strict-mode failure
   * for any automation and, worse, a screen reader reading the same thing twice
   * with nothing to tell a user which room it belongs to. Naming the state
   * fixes both, and costs the visible label nothing.
   */
  aria?: string | undefined
  tone: ChipTone
  selected: boolean
  onClick?: (() => void) | undefined
}

interface PlacedChip {
  chip: ChipSpec
  x: number
  y: number
  w: number
}

/** Packs chips left-to-right, wrapping to a new `rowH`-tall row inside
 *  `maxWidth` — the node card's chip rows are wrap-safe by construction
 *  rather than hard-coded to a fixed count. */
function layoutChipRow(chips: ChipSpec[], x0: number, y0: number, maxWidth: number, rowH: number): PlacedChip[] {
  const out: PlacedChip[] = []
  let x = x0
  let y = y0
  for (const chip of chips) {
    const w = approxTextWidth(chip.label, 9) + 12
    if (x + w > x0 + maxWidth && x > x0) {
      x = x0
      y += rowH
    }
    out.push({ chip, x, y, w })
    x += w + 6
  }
  return out
}

function chipRowBottom(placed: PlacedChip[], fallbackY: number, rowH: number): number {
  if (placed.length === 0) return fallbackY
  let maxY = fallbackY
  for (const p of placed) maxY = Math.max(maxY, p.y)
  return maxY + rowH
}

function chipColor(tone: ChipTone, selected: boolean): { stroke: string; text: string } {
  switch (tone) {
    case 'cyan':
      return { stroke: selected ? 'var(--override)' : 'var(--override-line)', text: 'var(--override)' }
    case 'terminal':
    case 'endingOutline':
      return { stroke: 'var(--err)', text: 'var(--err)' }
    case 'info':
      return { stroke: 'var(--line)', text: 'var(--dim)' }
  }
}

/** The minimap's box, and the graph-space margin around the nodes inside it. */
const MINIMAP_W = 148
const MINIMAP_H = 96
const MINIMAP_PAD = 80

export function GraphCanvas({
  states,
  events,
  cutscenes = [],
  entrance,
  selected,
  onSelect,
  diagnostics = [],
  layout,
  onMoveNode,
}: {
  states: Record<string, SMState>
  events: SMEvent[]
  /** Clips a transition's `to` may name instead of a state; the edge is drawn
   *  to the state the cut lands in. */
  cutscenes?: readonly { id: string; to: string }[] | undefined
  entrance?: string | undefined
  selected: EditorSelection
  onSelect: (sel: EditorSelection) => void
  /** Positions a person put a node in, overriding the automatic layout.
   *  Editor state persisted beside the world, never IN it: where a card sits
   *  on your screen is not a fact about the world, and two authors dragging
   *  the same graph should not conflict. */
  layout?: Record<string, XY> | undefined
  /** Commit a dragged node. Absent means the graph is not draggable. */
  onMoveNode?: ((id: string, at: XY) => void) | undefined
  /** Doctrine hits (`../world` `runDoctrine`, or a hosted `lint`/`validate`
   *  call) to colour nodes/edges from. Optional — an empty list (or none at
   *  all) just means every node/edge renders at its unlinted default. */
  diagnostics?: Diagnostic[] | undefined
}) {
  const ids = useMemo(() => Object.keys(states), [states])
  const idSignature = useMemo(() => [...ids].sort().join('\u0000'), [ids])
  const rawEdges = useMemo(() => collectEdges(states, events, cutscenes), [states, events, cutscenes])
  const auto = useMemo(() => autoLayout(ids, rawEdges, entrance), [ids, rawEdges, entrance])
  // A node a person MOVED wins over the automatic layout, and only for as long
  // as that node exists — a stale entry for a deleted state is dropped rather
  // than left to place a card nobody can see.
  const { pos, rank } = useMemo(() => {
    if (!layout || Object.keys(layout).length === 0) return auto
    const merged = new Map(auto.pos)
    for (const [id, at] of Object.entries(layout)) if (merged.has(id)) merged.set(id, at)
    return { pos: merged, rank: auto.rank }
  }, [auto, layout])
  const { byState, byEvent } = useMemo(() => bucketDiagnostics(diagnostics), [diagnostics])

  // Per (from,to) pair bookkeeping — a running index + total count — so
  // parallel/bidirectional edges fan out and same-state self-loops stack.
  const edgeLayout = useMemo(() => {
    const totalByPair = new Map<string, number>()
    for (const e of rawEdges) {
      const k = pairKey(e.from, e.to)
      totalByPair.set(k, (totalByPair.get(k) ?? 0) + 1)
    }
    const seenByPair = new Map<string, number>()
    return rawEdges.map((e) => {
      const k = pairKey(e.from, e.to)
      const order = seenByPair.get(k) ?? 0
      seenByPair.set(k, order + 1)
      return { ...e, order, count: totalByPair.get(k) ?? 1 }
    })
  }, [rawEdges])

  const bounds = useMemo(() => {
    let minX = Infinity
    let minY = Infinity
    let maxX = -Infinity
    let maxY = -Infinity
    for (const id of ids) {
      const p = pos.get(id)
      if (!p) continue
      minX = Math.min(minX, p.x - NODE_W / 2)
      maxX = Math.max(maxX, p.x + NODE_W / 2)
      minY = Math.min(minY, p.y - NODE_H / 2)
      maxY = Math.max(maxY, p.y + NODE_H / 2)
    }
    return minX === Infinity ? null : { minX, minY, maxX, maxY }
  }, [ids, pos])

  const containerRef = useRef<HTMLDivElement | null>(null)
  const svgRef = useRef<SVGSVGElement | null>(null)
  const fittedRef = useRef<string>('')
  const dragRef = useRef<{ startX: number; startY: number; camX: number; camY: number; moved: boolean } | null>(null)
  const [camera, setCamera] = useState({ x: 0, y: 0, scale: 1 })
  /** The pane's size. The minimap needs it to draw the VIEWPORT rectangle —
   *  where the camera is looking is a fact about the pane, not the graph. */
  const [pane, setPane] = useState({ w: 0, h: 0 })
  const [isPanning, setIsPanning] = useState(false)

  // Fit-on-load: refit the camera whenever the STATE SET changes (a
  // different world opened, a state added or removed) but not on prose- or
  // edge-only edits, so the camera does not jump under an author mid-edit.
  // `bounds` is a pure function of ids/edges/entrance, so the box captured
  // here is already correct for the render in which `idSignature` last
  // changed — a ResizeObserver retries until the pane actually has a size.
  useEffect(() => {
    const el = containerRef.current
    if (!el || !bounds) return
    const b = bounds
    // An arrow-function const, not a function declaration: TS only carries
    // the non-null narrowing of `el` above into a closure it can prove was
    // not hoisted ahead of that check.
    const tryFit = (): void => {
      if (fittedRef.current === idSignature) return
      const cw = el.clientWidth
      const ch = el.clientHeight
      if (cw === 0 || ch === 0) return
      const margin = 60
      const bw = Math.max(b.maxX - b.minX, 1)
      const bh = Math.max(b.maxY - b.minY, 1)
      // Fit, but never below what a card can be READ at. A six-state graph is
      // 2600px wide and the editor pane is under a thousand, so a pure fit
      // shrinks the prose to grey lint — technically the whole graph, usably
      // nothing. Better to open legible on the entrance end and let the author
      // pan or zoom out deliberately.
      const READABLE = 0.75
      const fit = Math.min((cw - margin * 2) / bw, (ch - margin * 2) / bh)
      const scale = clamp(Math.max(fit, Math.min(READABLE, MAX_ZOOM)), MIN_ZOOM, MAX_ZOOM)
      const cy = (b.minY + b.maxY) / 2
      const wide = bw * scale > cw - margin * 2
      // Everything fits: centre it. It does not: start where the world starts.
      const x = wide ? margin - b.minX * scale : cw / 2 - ((b.minX + b.maxX) / 2) * scale
      setCamera({ scale, x, y: ch / 2 - cy * scale })
      fittedRef.current = idSignature
    }
    const measure = (): void => {
      setPane((prev) => (prev.w === el.clientWidth && prev.h === el.clientHeight ? prev : { w: el.clientWidth, h: el.clientHeight }))
      tryFit()
    }
    measure()
    const obs = new ResizeObserver(measure)
    obs.observe(el)
    return () => obs.disconnect()
  }, [idSignature, bounds])

  // Wheel zoom, clamped, centred on the cursor — a raw listener (not React's
  // onWheel) so preventDefault reliably stops the page itself from scrolling.
  useEffect(() => {
    const el = containerRef.current
    if (!el) return
    const handleWheel = (e: WheelEvent): void => {
      e.preventDefault()
      const rect = el.getBoundingClientRect()
      const mx = e.clientX - rect.left
      const my = e.clientY - rect.top
      setCamera((cam) => {
        const factor = Math.exp(-e.deltaY * 0.0015)
        const nextScale = clamp(cam.scale * factor, MIN_ZOOM, MAX_ZOOM)
        const worldX = (mx - cam.x) / cam.scale
        const worldY = (my - cam.y) / cam.scale
        return { scale: nextScale, x: mx - worldX * nextScale, y: my - worldY * nextScale }
      })
    }
    el.addEventListener('wheel', handleWheel, { passive: false })
    return () => el.removeEventListener('wheel', handleWheel)
  }, [])

  // Background-drag pan. Nodes/edges render after (on top of) empty canvas
  // space, so a pointerdown that actually HITS the bare <svg> (not a card or
  // an edge) is the background — that same "hit nothing" pointerup, if the
  // pointer never moved, also clears selection.
  function onBackgroundPointerDown(e: React.PointerEvent<SVGSVGElement>): void {
    if (e.target !== svgRef.current) return
    // Otherwise a drag that crosses over a card's text also starts the
    // browser's native text-selection drag, highlighting prose while panning.
    e.preventDefault()
    e.currentTarget.setPointerCapture(e.pointerId)
    dragRef.current = { startX: e.clientX, startY: e.clientY, camX: camera.x, camY: camera.y, moved: false }
    setIsPanning(true)
  }
  function onBackgroundPointerMove(e: React.PointerEvent<SVGSVGElement>): void {
    const d = dragRef.current
    if (!d) return
    const dx = e.clientX - d.startX
    const dy = e.clientY - d.startY
    if (Math.abs(dx) > 3 || Math.abs(dy) > 3) d.moved = true
    setCamera((cam) => ({ ...cam, x: d.camX + dx, y: d.camY + dy }))
  }
  function onBackgroundPointerUp(e: React.PointerEvent<SVGSVGElement>): void {
    const d = dragRef.current
    dragRef.current = null
    setIsPanning(false)
    if (d && !d.moved && e.target === svgRef.current) onSelect(null)
  }
  function onBackgroundPointerCancel(): void {
    dragRef.current = null
    setIsPanning(false)
  }

  /**
   * DRAGGING A NODE. Its own pointer bookkeeping, separate from the background
   * pan: the two must never both run, or moving a card also moves the camera
   * under it and the card appears to fly.
   *
   * A drag under the threshold is a CLICK — this is `role="button"`, and taking
   * the press away from selection would break selecting a node with the mouse.
   */
  const nodeDragRef = useRef<{ id: string; startX: number; startY: number; from: XY; moved: boolean } | null>(null)
  const [dragging, setDragging] = useState<{ id: string; at: XY } | null>(null)

  function onNodePointerDown(e: React.PointerEvent<SVGGElement>, id: string): void {
    if (!onMoveNode) return
    e.stopPropagation()
    e.preventDefault()
    e.currentTarget.setPointerCapture(e.pointerId)
    const at = pos.get(id) ?? { x: 0, y: 0 }
    nodeDragRef.current = { id, startX: e.clientX, startY: e.clientY, from: at, moved: false }
  }
  function onNodePointerMove(e: React.PointerEvent<SVGGElement>): void {
    const d = nodeDragRef.current
    if (!d) return
    const dx = (e.clientX - d.startX) / camera.scale
    const dy = (e.clientY - d.startY) / camera.scale
    if (Math.abs(dx) > 3 || Math.abs(dy) > 3) d.moved = true
    if (d.moved) setDragging({ id: d.id, at: { x: d.from.x + dx, y: d.from.y + dy } })
  }
  function onNodePointerUp(e: React.PointerEvent<SVGGElement>, id: string): void {
    const d = nodeDragRef.current
    nodeDragRef.current = null
    const held = dragging
    setDragging(null)
    if (!d) return
    if (!d.moved) { selectState(id); return }
    if (held && onMoveNode) onMoveNode(id, held.at)
    e.stopPropagation()
  }

  function isStateSelected(id: string): boolean {
    return selected?.kind === 'state' && selected.id === id
  }
  function isEventSelected(name: string): boolean {
    return selected?.kind === 'event' && selected.name === name
  }

  function selectState(id: string): void {
    onSelect({ kind: 'state', id })
  }
  function selectEvent(name: string): void {
    onSelect({ kind: 'event', name })
  }

  function renderNode(id: string) {
    const p = pos.get(id)
    const state = states[id]
    if (!p || !state) return null
    const isEntrance = id === entrance
    const isSel = isStateSelected(id)
    const { errors, warnings } = severityCounts(byState.get(id) ?? [])
    const borderColor = errors > 0 ? 'var(--err)' : warnings > 0 ? 'var(--warn)' : isSel ? 'var(--acc)' : 'var(--line)'

    // Every event this state can fire that is NOT an edge (no resolvable
    // `to`) lives inside the card: override events cyan, a bare terminal
    // (an ending trigger with no named destination) red.
    const overrideChips: ChipSpec[] = []
    const cutByIdForChips = new Map(cutscenes.map((c) => [c.id, c]))
    for (const ev of events) {
      if (!ev.from.includes(id)) continue
      if (edgeTarget(ev, states, cutByIdForChips) !== undefined) continue
      if (ev.kind === 'override') {
        overrideChips.push({ key: ev.name, label: ev.name, aria: `${ev.name} in ${id}`, tone: 'cyan', selected: isEventSelected(ev.name), onClick: () => selectEvent(ev.name) })
      } else if (ev.kind === 'terminal') {
        overrideChips.push({ key: ev.name, label: ev.name, aria: `${ev.name} in ${id}`, tone: 'terminal', selected: isEventSelected(ev.name), onClick: () => selectEvent(ev.name) })
      }
    }

    // Info chips: only when actually authored, never as unconditional
    // placeholders, plus a red ENDING chip when `state.ending` marks this
    // the state's own stopping point.
    const infoChips: ChipSpec[] = []
    if (state.camera) infoChips.push({ key: 'cam', label: 'cam', tone: 'info', selected: false })
    if (state.movement) infoChips.push({ key: 'move', label: 'move', tone: 'info', selected: false })
    if (state.ambient && state.ambient.length > 0) {
      infoChips.push({ key: 'ambient', label: `${state.ambient.length} ambient`, tone: 'info', selected: false })
    }
    if (state.ending) infoChips.push({ key: 'ending', label: 'ENDING', tone: 'endingOutline', selected: false })

    const pad = 10
    const headerY = 20
    const bodyY = 40
    const lineH = 13
    const chipRowH = 18
    const lines = wrapToLines(trunc(state.base, 120), 34, 4)

    const infoRowY = bodyY + lines.length * lineH + 10
    const infoRow = layoutChipRow(infoChips, pad, infoRowY, NODE_W - pad * 2, chipRowH)
    const infoBottom = chipRowBottom(infoRow, infoRowY, chipRowH)
    const overrideRowY = infoBottom + 10
    const overrideRow = layoutChipRow(overrideChips, pad, overrideRowY, NODE_W - pad * 2, chipRowH)

    const idWidth = approxTextWidth(trunc(id), 12)
    const badge = errors > 0 ? { label: `${errors}✕`, bg: 'var(--err)' } : warnings > 0 ? { label: `${warnings}!`, bg: 'var(--warn)' } : null
    const badgeW = badge ? approxTextWidth(badge.label, 9) + 8 : 0

    return (
      <g
        key={id}
        role="button"
        tabIndex={0}
        aria-label={`state ${id}`}
        aria-pressed={isSel}
        onPointerDown={(e) => onNodePointerDown(e, id)}
        onPointerMove={onNodePointerMove}
        onPointerUp={(e) => onNodePointerUp(e, id)}
        onPointerCancel={() => { nodeDragRef.current = null; setDragging(null) }}
        onClick={() => { if (!onMoveNode) selectState(id) }}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault()
            selectState(id)
          }
        }}
        transform={`translate(${(dragging?.id === id ? dragging.at.x : p.x) - NODE_W / 2} ${(dragging?.id === id ? dragging.at.y : p.y) - NODE_H / 2})`}
        style={{
          cursor: onMoveNode ? (dragging?.id === id ? 'grabbing' : 'grab') : 'pointer',
          filter: isSel ? 'drop-shadow(0 0 6px var(--acc))' : undefined,
        }}
      >
        <g clipPath="url(#gc-card-clip)">
          <rect width={NODE_W} height={NODE_H} style={{ fill: 'var(--panel2)', stroke: borderColor, strokeWidth: isSel ? 2.4 : 1.4 }} />
          <text x={pad} y={headerY} style={{ fill: 'var(--acc)', fontSize: 12, fontWeight: 700, fontFamily: 'var(--mono)' }}>
            {trunc(id)}
          </text>
          {isEntrance && (
            <g transform={`translate(${pad + idWidth + 8} ${headerY - 12})`}>
              <rect width={42} height={14} rx={2} style={{ fill: 'none', stroke: 'var(--acc)' }} />
              <text x={21} y={7} textAnchor="middle" dominantBaseline="central" style={{ fill: 'var(--acc)', fontSize: 8, letterSpacing: 1, fontFamily: 'var(--mono)' }}>
                START
              </text>
            </g>
          )}
          {badge && (
            <g transform={`translate(${NODE_W - pad - badgeW} ${headerY - 12})`}>
              <rect width={badgeW} height={14} rx={2} style={{ fill: badge.bg }} />
              <text x={badgeW / 2} y={7} textAnchor="middle" dominantBaseline="central" style={{ fill: 'var(--panel2)', fontSize: 9, fontWeight: 700, fontFamily: 'var(--mono)' }}>
                {badge.label}
              </text>
            </g>
          )}
          {lines.map((line, i) => (
            <text key={i} x={pad} y={bodyY + i * lineH} style={{ fill: 'var(--dim)', fontSize: 10, fontFamily: 'var(--mono)' }}>
              {line}
            </text>
          ))}
          {infoRow.map(({ chip, x, y, w }) => {
            const c = chipColor(chip.tone, chip.selected)
            return (
              <g key={chip.key} transform={`translate(${x} ${y})`}>
                <rect width={w} height={14} rx={2} style={{ fill: 'none', stroke: c.stroke }} />
                <text x={w / 2} y={7} textAnchor="middle" dominantBaseline="central" style={{ fill: c.text, fontSize: 9, fontFamily: 'var(--mono)' }}>
                  {chip.label}
                </text>
              </g>
            )
          })}
          {overrideRow.length > 0 && (
            <line x1={0} y1={infoBottom + 5} x2={NODE_W} y2={infoBottom + 5} style={{ stroke: 'var(--line)', strokeDasharray: '2 4' }} />
          )}
          {overrideRow.map(({ chip, x, y, w }) => {
            const c = chipColor(chip.tone, chip.selected)
            return (
              <g
                key={chip.key}
                transform={`translate(${x} ${y})`}
                role="button"
                tabIndex={0}
                aria-label={`event ${chip.aria ?? chip.key}`}
                aria-pressed={chip.selected}
                // POINTERDOWN, not click — met more than once, and the
                // mechanism is worth stating exactly because the obvious
                // guess is wrong. The mouse does not move; THE CHIP does.
                // Traced with a capture-phase listener on a stationary
                // cursor:
                //
                //   pointerdown -> text in "event listen in lane"
                //   pointerup   -> g in "state lane"
                //   click       -> g in "state lane"
                //
                // Pressing selects the state, the node re-renders with its
                // selected styling, and the chips shift by a pixel or two — so
                // the release lands on the node underneath and `click`, which
                // resolves on the common ancestor of press and release, is
                // handed to the state. The element is never replaced
                // (`isConnected` stays true); it simply is not where it was.
                // Selection feedback moving the thing you are clicking is the
                // whole bug. The player's chips were already fixed this way;
                // the editor's carried it until someone tried to click one
                // from a driver.
                onPointerDown={(e) => {
                  e.stopPropagation()
                  chip.onClick?.()
                }}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault()
                    e.stopPropagation()
                    chip.onClick?.()
                  }
                }}
                style={{ cursor: 'pointer', filter: chip.selected && chip.tone === 'cyan' ? 'drop-shadow(0 0 4px var(--override))' : undefined }}
              >
                {/* `transparent`, NOT `none`: an SVG rect with fill:none paints
                    nothing AND hit-tests nothing, so only the 1px stroke and the
                    glyphs took the click — aim anywhere else inside the chip and
                    it fell through to the node underneath, which selected the
                    STATE instead. An override or terminal was therefore
                    unreachable from the canvas unless you happened to hit its
                    letters. It survived because that is where people aim. */}
                <rect width={w} height={14} rx={2} style={{ fill: 'transparent', stroke: c.stroke, strokeWidth: chip.selected ? 1.6 : 1 }} />
                <text x={w / 2} y={7} textAnchor="middle" dominantBaseline="central" style={{ fill: c.text, fontSize: 9, fontFamily: 'var(--mono)' }}>
                  {chip.label}
                </text>
              </g>
            )
          })}
        </g>
      </g>
    )
  }

  function renderEdge(e: { name: string; kind: SMEvent['kind']; from: string; to: string; order: number; count: number }, i: number) {
    const a = pos.get(e.from)
    const b = pos.get(e.to)
    if (!a || !b) return null
    const isSelfLoop = e.from === e.to
    const isSel = isEventSelected(e.name)
    const { errors, warnings } = severityCounts(byEvent.get(e.name) ?? [])
    const isBack = !isSelfLoop && (rank.get(e.to) ?? 0) <= (rank.get(e.from) ?? 0)

    // Colour priority, exactly: lint-error -> lint-warning ->
    // terminal-red-by-default -> selection-green -> default grey. A terminal
    // event reads as an ending path even with zero lints.
    const tone: 'err' | 'warn' | 'acc' | 'dim' =
      errors > 0 ? 'err' : warnings > 0 ? 'warn' : e.kind === 'terminal' ? 'err' : isSel ? 'acc' : 'dim'
    const color = `var(--${tone})`
    const strokeWidth = isSel ? 2.5 : 1.5
    const dash = e.kind === 'terminal' ? '6 4' : isBack || isSelfLoop ? '2 4' : undefined

    let d: string
    let labelX: number
    let labelY: number

    if (isSelfLoop) {
      // Cubic bow above the card; multiple self-loops on the same state
      // stack upward by their running index so they never collide.
      const top = a.y - NODE_H / 2 - SELF_R - e.order * 20
      const x0 = a.x - 24
      const x1 = a.x + 24
      const y0 = a.y - NODE_H / 2
      d = `M ${x0} ${y0} C ${x0} ${top}, ${x1} ${top}, ${x1} ${y0}`
      labelX = a.x
      labelY = top + 10
    } else {
      let k = 0
      if (isBack) {
        const offset = (e.order - (e.count - 1) / 2) * GAP
        k = offset + Math.sign(offset || 1) * BACK_BOW
      } else if (e.count > 1) {
        k = (e.order - (e.count - 1) / 2) * GAP
      }
      const start = shortenToRect(a, b, NODE_W / 2, NODE_H / 2, 8)
      const end = shortenToRect(b, a, NODE_W / 2, NODE_H / 2, 8)
      const mid = { x: (start.x + end.x) / 2, y: (start.y + end.y) / 2 }
      const dx = end.x - start.x
      const dy = end.y - start.y
      const len = Math.hypot(dx, dy) || 1
      const nx = -dy / len
      const ny = dx / len
      const c = { x: mid.x + nx * k, y: mid.y + ny * k }
      d = `M ${start.x} ${start.y} Q ${c.x} ${c.y} ${end.x} ${end.y}`
      // The quadratic's true midpoint at t=0.5.
      labelX = 0.25 * start.x + 0.5 * c.x + 0.25 * end.x
      labelY = 0.25 * start.y + 0.5 * c.y + 0.25 * end.y
    }

    const glyph = isBack || isSelfLoop ? '↺ ' : ''
    const label = `${glyph}${trunc(e.name, 22)}`
    const labelW = approxTextWidth(label, 11) + 14

    return (
      <g
        key={`${e.from}\u0000${e.to}\u0000${e.name}\u0000${i}`}
        role="button"
        tabIndex={0}
        aria-label={`event ${e.name}`}
        aria-pressed={isSel}
        onClick={() => selectEvent(e.name)}
        onKeyDown={(ev) => {
          if (ev.key === 'Enter' || ev.key === ' ') {
            ev.preventDefault()
            selectEvent(e.name)
          }
        }}
        style={{ cursor: 'pointer' }}
      >
        <path d={d} markerEnd={`url(#gc-arrow-${tone})`} style={{ fill: 'none', stroke: color, strokeWidth, strokeDasharray: dash }} />
        <rect x={labelX - labelW / 2} y={labelY - 9} width={labelW} height={18} rx={2} style={{ fill: 'var(--panel2)', stroke: color }} />
        <text x={labelX} y={labelY} textAnchor="middle" dominantBaseline="central" style={{ fill: color, fontSize: 11, fontFamily: 'var(--mono)' }}>
          {label}
        </text>
      </g>
    )
  }

  if (ids.length === 0) {
    return <div className="empty">This world has no states yet. Use the Inspector, or ask the kernel agent below.</div>
  }

  return (
    <div ref={containerRef} style={{ width: '100%', height: '100%', overflow: 'hidden' }}>
      <svg
        ref={svgRef}
        width="100%"
        height="100%"
        style={{ display: 'block', cursor: isPanning ? 'grabbing' : 'default', touchAction: 'none', userSelect: 'none' }}
        onPointerDown={onBackgroundPointerDown}
        onPointerMove={onBackgroundPointerMove}
        onPointerUp={onBackgroundPointerUp}
        onPointerCancel={onBackgroundPointerCancel}
      >
        <defs>
          <clipPath id="gc-card-clip">
            <rect width={NODE_W} height={NODE_H} />
          </clipPath>
          {(['dim', 'acc', 'err', 'warn'] as const).map((tone) => (
            <marker key={tone} id={`gc-arrow-${tone}`} viewBox="0 0 10 10" refX="9" refY="5" markerWidth={7} markerHeight={7} orient="auto-start-reverse">
              <path d="M0,0 L10,5 L0,10 z" style={{ fill: `var(--${tone})` }} />
            </marker>
          ))}
        </defs>
        <g transform={`translate(${camera.x} ${camera.y}) scale(${camera.scale})`}>
          {edgeLayout.map((e, i) => renderEdge(e, i))}
          {ids.map((id) => renderNode(id))}
        </g>
      </svg>

      {/* THE MINIMAP. A graph outgrows its pane quickly — the shipped example is
          2600px wide against an editor pane under a thousand — and once it does,
          panning is navigation by memory. This is the whole graph at a glance,
          with the rectangle showing what the pane is currently looking at, and
          a click to go there.

          Drawn only when there is more than one node: a minimap of a single
          state is a decoration that says nothing. */}
      {bounds && ids.length > 1 && pane.w > 0 && (
        <svg
          className="minimap"
          width={MINIMAP_W}
          height={MINIMAP_H}
          role="button"
          tabIndex={0}
          aria-label="Graph minimap — click to move the view"
          onClick={(e) => {
            const box = e.currentTarget.getBoundingClientRect()
            const fx = (e.clientX - box.left) / box.width
            const fy = (e.clientY - box.top) / box.height
            // Where that is in GRAPH space, then centre the pane on it.
            const gx = bounds.minX - MINIMAP_PAD + fx * (bounds.maxX - bounds.minX + MINIMAP_PAD * 2)
            const gy = bounds.minY - MINIMAP_PAD + fy * (bounds.maxY - bounds.minY + MINIMAP_PAD * 2)
            setCamera((cam) => ({ ...cam, x: pane.w / 2 - gx * cam.scale, y: pane.h / 2 - gy * cam.scale }))
          }}
          onKeyDown={(e) => {
            if (e.key !== 'Enter' && e.key !== ' ') return
            e.preventDefault()
            // Keyboard users get the one move that is unambiguous: fit the whole
            // graph, which is what the minimap is showing them.
            const cx = (bounds.minX + bounds.maxX) / 2
            const cy = (bounds.minY + bounds.maxY) / 2
            setCamera((cam) => ({ ...cam, x: pane.w / 2 - cx * cam.scale, y: pane.h / 2 - cy * cam.scale }))
          }}
        >
          {(() => {
            const gw = bounds.maxX - bounds.minX + MINIMAP_PAD * 2
            const gh = bounds.maxY - bounds.minY + MINIMAP_PAD * 2
            const k = Math.min(MINIMAP_W / gw, MINIMAP_H / gh)
            const ox = (MINIMAP_W - gw * k) / 2
            const oy = (MINIMAP_H - gh * k) / 2
            const mx = (x: number) => ox + (x - bounds.minX + MINIMAP_PAD) * k
            const my = (y: number) => oy + (y - bounds.minY + MINIMAP_PAD) * k
            // What the pane is looking at, in graph coordinates.
            const view = {
              x: -camera.x / camera.scale,
              y: -camera.y / camera.scale,
              w: pane.w / camera.scale,
              h: pane.h / camera.scale,
            }
            return (
              <>
                <rect
                  x={mx(view.x)}
                  y={my(view.y)}
                  width={Math.max(2, view.w * k)}
                  height={Math.max(2, view.h * k)}
                  className="minimap-view"
                />
                {ids.map((id) => {
                  const p = pos.get(id)
                  if (!p) return null
                  const tone = id === entrance ? 'entrance' : isStateSelected(id) ? 'selected' : 'node'
                  return <circle key={id} cx={mx(p.x)} cy={my(p.y)} r={2.5} className={`minimap-dot ${tone}`} />
                })}
              </>
            )
          })()}
        </svg>
      )}
    </div>
  )
}
