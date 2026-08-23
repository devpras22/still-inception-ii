/**
 * Mock world model — the zero-key default.
 *
 * The studio has to do something the moment it is cloned, before the user has an
 * account anywhere, or the first run is a settings form and a black rectangle.
 * So this provider draws. No fetch, no socket, no key: a canvas that renders the
 * world's prompt, the state the machine is currently in, and every event the
 * studio pushes at it.
 *
 * It reports `promptableEvents: true` and MEANS it — beats really do change the
 * picture. That is the point: an author can build and drive an entire state
 * machine offline, then swap in Reactor or their own WebSocket and only then
 * find out whether their backend keeps that promise.
 *
 * It is a stub, not a renderer. It draws text and a grid instead of generating
 * video, and `capabilities.note` says so, because a stub that quietly pretends to
 * be a world model is worse than no stub at all.
 */

import type {
  WorldCapabilities,
  WorldConnectOptions,
  WorldEvent,
  WorldModelProvider,
  WorldSession,
} from '../types'

const CAPABILITIES: WorldCapabilities = {
  streaming: true,
  promptableEvents: true,
  heldCommands: true,
  persistentWorlds: false,
  note:
    'Local stub — draws your prompt, state and events onto a canvas instead of generating video. ' +
    'No key and no network, and every authored beat is honoured, so you can exercise a whole ' +
    'state machine offline. Worlds are not persisted by this provider.',
}

// Studio palette (styles.css) so the canvas reads as part of the app, not as an
// error state someone forgot to style. Kept as hex literals rather than CSS
// tokens ON PURPOSE: this canvas fakes a VIDEO FEED, which is content, not
// chrome, and a stub that repainted itself on a light/dark theme flip would
// misrepresent the real feed it stands in for. Same reasoning covers the
// canvas element's own background and the drawSky() gradient stops below —
// none of it should move when --acc/--ink/etc. do.
const SKY_TOP = '#05060a'
const SKY_BOTTOM = '#0d1a29'
const INK = '#dfe8f0'
const DIM = '#8595a8'
// Both ACC and ACC2 used to be a teal/mint and a light blue — a hue neither
// product's palette has anywhere else (black/white/phosphor-green, red only
// for an ending). The wireframe grid and the STATE heading below are the two
// places that showed, so both are now the same phosphor-green family as
// every other accent in the app: full-strength for state/log emphasis,
// the lighter tint for the second voice (prompt log lines, the state name).
const ACC = '#00ff00'
const ACC2 = '#57ff57'
const WARN = '#ffcf6b'
const MONO = 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace'

const LOG_LIMIT = 40
const LOG_VISIBLE = 6

interface LogLine {
  at: number
  kind: WorldEvent['kind'] | 'system'
  text: string
}

interface Star {
  x: number
  y: number
  r: number
  phase: number
}

/** Deterministic PRNG so the starfield is stable frame to frame (mulberry32). */
function prng(seed: number): () => number {
  let s = seed >>> 0
  return () => {
    s = (s + 0x6d2b79f5) >>> 0
    let t = Math.imul(s ^ (s >>> 15), 1 | s)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/**
 * Command tokens map to a drive impulse. Unknown tokens still land as a pulse:
 * an author testing a custom token needs to see SOMETHING move, otherwise they
 * cannot tell a bad token from a dropped event.
 */
function driveImpulse(token: string): { x: number; y: number; z: number } {
  // The studio's drive vocabulary is EXACTLY six tokens (Player's DRIVE_KEYS).
  // This used to be a synonym regex ("forward|ahead|north|…") that inferred
  // meaning from English nobody sends — the mock speaks the protocol, it does
  // not interpret prose. An unknown token keeps the gentle default drift, the
  // same "moving world" fallback a dropped event gets.
  switch (token.trim().toLowerCase()) {
    case 'front': return { x: 0, y: 0, z: 1 }
    case 'back': return { x: 0, y: 0, z: -1 }
    case 'left': return { x: -1, y: 0, z: 0 }
    case 'right': return { x: 1, y: 0, z: 0 }
    case 'up': return { x: 0, y: 1, z: 0 }
    case 'down': return { x: 0, y: -1, z: 0 }
    default: return { x: 0, y: 0, z: 0.35 }
  }
}

function clock(ms: number): string {
  const s = Math.floor(ms / 1000)
  return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`
}

function wrap(ctx: CanvasRenderingContext2D, text: string, maxWidth: number, maxLines: number): string[] {
  const words = text.split(/\s+/).filter(Boolean)
  const lines: string[] = []
  let line = ''
  for (const word of words) {
    const next = line ? `${line} ${word}` : word
    if (ctx.measureText(next).width <= maxWidth || !line) {
      line = next
      continue
    }
    lines.push(line)
    line = word
    if (lines.length === maxLines) break
  }
  if (lines.length < maxLines && line) lines.push(line)
  if (lines.length === maxLines) {
    const last = lines[maxLines - 1] ?? ''
    if (ctx.measureText(last).width > maxWidth - 12) lines[maxLines - 1] = `${last.slice(0, Math.max(0, last.length - 2))}…`
  }
  return lines
}

class MockSession implements WorldSession {
  readonly capabilities = CAPABILITIES

  private readonly worldId: string
  private prompt: string
  private readonly stars: Star[]

  private canvas: HTMLCanvasElement | null = null
  private ctx: CanvasRenderingContext2D | null = null
  private raf = 0
  private lastFrameAt = 0
  private frames = 0

  // Session time is WALL time, not accumulated frame deltas: a backgrounded tab
  // gets its rAF throttled to a crawl, and a clock built from frames would tell
  // the author their five-minute session lasted nine seconds.
  private readonly startedAt = performance.now()
  private elapsed = 0

  private log: LogLine[] = []
  private eventCount = 0
  private stateName = 'entrance'
  private stateChangedAt = -1e9
  private beatAt = -1e9
  private beatKind: WorldEvent['kind'] = 'prompt'

  // Camera: `drive` is the decaying impulse from held commands, the rest is
  // where that impulse has carried us.
  private drive = { x: 0, y: 0, z: 0 }
  private travel = 0
  private strafe = 0
  private bob = 0

  private handlers = new Set<(reason: string) => void>()
  private endedReason: string | null = null
  private disposed = false

  constructor(options: WorldConnectOptions) {
    this.worldId = options.worldId
    this.prompt = (options.prompt || '').trim()
    const rand = prng(hash(options.worldId))
    this.stars = Array.from({ length: 110 }, () => ({
      x: rand(),
      y: rand(),
      r: 0.4 + rand() * 1.3,
      phase: rand() * Math.PI * 2,
    }))
    this.push('system', 'session opened · mock provider')
    if (options.firstFrameUrl) this.push('system', 'first frame supplied — not fetched (offline stub)')
  }

  mount(container: HTMLElement): void {
    this.unmount()
    const canvas = document.createElement('canvas')
    canvas.style.cssText = 'display:block;width:100%;height:100%;border-radius:8px;background:#05060a'
    canvas.setAttribute('role', 'img')
    canvas.setAttribute('aria-label', `Mock world render for ${this.worldId}`)
    container.appendChild(canvas)
    this.canvas = canvas

    const ctx = canvas.getContext('2d')
    if (!ctx) {
      // A missing 2D context is a real provider-side death, not a silent no-op:
      // drop the canvas that will never paint, say so in the DOM, and tell the
      // studio to stop pretending it is live.
      this.unmount()
      container.appendChild(fallbackNotice())
      this.end('canvas 2d context unavailable in this browser')
      return
    }
    this.ctx = ctx
    this.lastFrameAt = 0
    this.raf = requestAnimationFrame(this.frame)
  }

  async sendEvent(event: WorldEvent): Promise<void> {
    if (this.disposed || this.endedReason) return
    // Events can land between frames (or while frames are throttled), so stamp
    // them from the clock rather than from whenever the renderer last woke up.
    this.elapsed = performance.now() - this.startedAt
    this.eventCount += 1
    this.beatAt = this.elapsed
    this.beatKind = event.kind
    const value = (event.value || '').trim()

    if (event.kind === 'state') {
      this.stateName = event.stateId || value || this.stateName
      this.stateChangedAt = this.elapsed
      // Redraw the scene prose too. This panel claims to draw "your prompt, your
      // state and your events", and the prompt was captured once at connect and
      // never touched again — so after a transition the canvas showed the new
      // state's NAME above the old state's description, which is a worse lie
      // than showing nothing.
      if (value) this.prompt = value
      this.push('state', this.stateName)
    } else if (event.kind === 'command') {
      const d = driveImpulse(value)
      // Additive with a ceiling: holding a key re-sends the token, so repeats
      // build speed the way a held input should, without running away.
      this.drive.x = clamp(this.drive.x + d.x * 0.55, -1.6, 1.6)
      this.drive.y = clamp(this.drive.y + d.y * 0.55, -1.6, 1.6)
      this.drive.z = clamp(this.drive.z + d.z * 0.55, -1.6, 2.2)
      this.push('command', value || '(unnamed)')
    } else {
      this.push('prompt', value || '(empty prompt)')
    }
  }

  onEnded(handler: (reason: string) => void): () => void {
    this.handlers.add(handler)
    // Late registration still gets the news — mount() can die before the studio
    // has wired its handler up.
    if (this.endedReason) {
      const reason = this.endedReason
      queueMicrotask(() => {
        if (this.handlers.has(handler)) handler(reason)
      })
    }
    return () => {
      this.handlers.delete(handler)
    }
  }

  async dispose(): Promise<void> {
    this.disposed = true
    this.unmount()
    this.handlers.clear()
  }

  // ── internals ─────────────────────────────────────────────────────────────

  private unmount(): void {
    if (this.raf) cancelAnimationFrame(this.raf)
    this.raf = 0
    this.canvas?.remove()
    this.canvas = null
    this.ctx = null
  }

  private end(reason: string): void {
    if (this.endedReason) return
    this.endedReason = reason
    for (const h of [...this.handlers]) h(reason)
  }

  private push(kind: LogLine['kind'], text: string): void {
    this.log.push({ at: this.elapsed, kind, text })
    if (this.log.length > LOG_LIMIT) this.log.splice(0, this.log.length - LOG_LIMIT)
  }

  private frame = (now: number): void => {
    // Guard before rescheduling: a frame that slips past dispose() would restart
    // the loop and keep the session drawing after the studio let go of it.
    if (this.disposed) return
    this.raf = requestAnimationFrame(this.frame)
    const ctx = this.ctx
    const canvas = this.canvas
    if (!ctx || !canvas) return

    // Clamp dt so a backgrounded tab does not teleport the camera on return. The
    // camera integrates dt; only the HUD clock reads wall time.
    const dt = this.lastFrameAt ? Math.min(0.05, (now - this.lastFrameAt) / 1000) : 0.016
    this.lastFrameAt = now
    this.elapsed = performance.now() - this.startedAt
    this.frames += 1

    const dpr = Math.min(2, window.devicePixelRatio || 1)
    const w = Math.max(1, canvas.clientWidth)
    const h = Math.max(1, canvas.clientHeight)
    if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(h * dpr)) {
      canvas.width = Math.round(w * dpr)
      canvas.height = Math.round(h * dpr)
    }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)

    // Impulses decay; the idle drift keeps the frame obviously live rather than
    // a still someone will mistake for a hang.
    const decay = Math.exp(-dt / 0.5)
    this.drive.x *= decay
    this.drive.y *= decay
    this.drive.z *= decay
    this.travel += (0.35 + this.drive.z) * dt
    this.strafe += this.drive.x * dt * 0.9
    this.bob = Math.sin(this.elapsed / 1400) * 6 + this.drive.y * 26

    this.drawSky(ctx, w, h)
    this.drawStars(ctx, w, h)
    this.drawGrid(ctx, w, h)
    this.drawVignette(ctx, w, h)
    this.drawHeader(ctx, w)
    this.drawState(ctx, h)
    this.drawLog(ctx, w, h)
    this.drawFooter(ctx, w, h)
    this.drawBeat(ctx, w, h)
  }

  private horizon(h: number): number {
    return h * 0.46 + this.bob
  }

  private drawSky(ctx: CanvasRenderingContext2D, w: number, h: number): void {
    const g = ctx.createLinearGradient(0, 0, 0, h)
    g.addColorStop(0, SKY_TOP)
    g.addColorStop(0.55, SKY_BOTTOM)
    g.addColorStop(1, '#060a10')
    ctx.fillStyle = g
    ctx.fillRect(0, 0, w, h)

    // Horizon glow, brighter right after a state change so a transition reads
    // as an event even out of the corner of your eye.
    const fresh = Math.max(0, 1 - (this.elapsed - this.stateChangedAt) / 900)
    const y = this.horizon(h)
    const glow = ctx.createLinearGradient(0, y - 90, 0, y + 24)
    glow.addColorStop(0, withAlpha(ACC2, 0))
    glow.addColorStop(1, withAlpha(ACC, 0.1 + fresh * 0.28))
    ctx.fillStyle = glow
    ctx.fillRect(0, y - 90, w, 114)
  }

  private drawStars(ctx: CanvasRenderingContext2D, w: number, h: number): void {
    const y0 = this.horizon(h)
    for (const s of this.stars) {
      const x = ((s.x - this.strafe * 0.06) % 1 + 1) % 1
      const twinkle = 0.35 + 0.35 * Math.sin(this.elapsed / 600 + s.phase)
      ctx.fillStyle = `rgba(223,232,240,${twinkle})`
      ctx.fillRect(x * w, s.y * Math.max(0, y0 - 12), s.r, s.r)
    }
  }

  private drawGrid(ctx: CanvasRenderingContext2D, w: number, h: number): void {
    const y0 = this.horizon(h)
    const depth = h - y0
    if (depth <= 4) return
    const vpx = w / 2 - Math.sin(this.strafe * 0.5) * w * 0.3

    ctx.save()
    ctx.beginPath()
    ctx.rect(0, y0, w, h - y0)
    ctx.clip()
    ctx.lineWidth = 1

    // Rails fanning out of the vanishing point.
    const lanes = 14
    const slide = ((this.strafe * 0.35) % 1 + 1) % 1
    for (let i = -lanes; i <= lanes; i++) {
      const t = i - slide
      ctx.strokeStyle = withAlpha(ACC2, 0.16 - Math.min(0.13, Math.abs(t) * 0.008))
      ctx.beginPath()
      ctx.moveTo(vpx, y0)
      ctx.lineTo(vpx + t * w * 0.34, h)
      ctx.stroke()
    }

    // Rungs sliding toward the camera: z shrinks as `travel` grows, so the
    // world visibly moves when a Front command lands.
    const scroll = ((this.travel % 1) + 1) % 1
    for (let i = 1; i <= 22; i++) {
      const z = i - scroll
      const y = y0 + depth / z
      if (y > h + 2) continue
      ctx.strokeStyle = withAlpha(ACC, Math.min(0.34, 0.34 / z))
      ctx.beginPath()
      ctx.moveTo(0, y)
      ctx.lineTo(w, y)
      ctx.stroke()
    }
    ctx.restore()
  }

  private drawVignette(ctx: CanvasRenderingContext2D, w: number, h: number): void {
    const g = ctx.createRadialGradient(w / 2, h / 2, Math.min(w, h) * 0.25, w / 2, h / 2, Math.max(w, h) * 0.75)
    g.addColorStop(0, 'rgba(0,0,0,0)')
    g.addColorStop(1, 'rgba(0,0,0,0.55)')
    ctx.fillStyle = g
    ctx.fillRect(0, 0, w, h)
  }

  private drawHeader(ctx: CanvasRenderingContext2D, w: number): void {
    ctx.textBaseline = 'top'
    ctx.textAlign = 'left'
    ctx.font = `700 12px ${MONO}`
    ctx.fillStyle = ACC
    ctx.fillText('MOCK WORLD MODEL', 20, 18)
    ctx.font = `11px ${MONO}`
    ctx.fillStyle = DIM
    ctx.fillText('drawing, not generating · no key · no network', 20, 36)

    // An empty prompt still gets a line: a blank slot reads as a rendering bug,
    // and the placeholder tells the author where their text would have gone.
    ctx.font = `13px ${MONO}`
    if (this.prompt) {
      ctx.fillStyle = withAlpha(INK, 0.9)
      const lines = wrap(ctx, this.prompt, Math.min(560, w - 40), 3)
      lines.forEach((line, i) => ctx.fillText(line, 20, 62 + i * 19))
    } else {
      ctx.fillStyle = withAlpha(DIM, 0.75)
      ctx.fillText('(no prompt — the studio sent none for this world)', 20, 62)
    }

    // Liveness dot: a still frame with a moving pulse is legible as "running".
    // Unlike the rest of this canvas (a fake VIDEO FEED, styled on purpose as
    // content rather than chrome), "LIVE" is a status readout, not picture
    // content — it renders in the site's one real accent, the same phosphor
    // green as every other status/CTA colour, not the feed's own muted teal.
    const pulse = 0.45 + 0.55 * Math.abs(Math.sin(this.elapsed / 700))
    ctx.textAlign = 'right'
    ctx.font = `11px ${MONO}`
    ctx.fillStyle = `rgba(0,255,0,${pulse})`
    ctx.fillText('LIVE', w - 20, 18)
    ctx.beginPath()
    ctx.arc(w - 62, 23, 4, 0, Math.PI * 2)
    ctx.fill()
    ctx.textAlign = 'left'
  }

  private drawState(ctx: CanvasRenderingContext2D, h: number): void {
    const fresh = Math.max(0, 1 - (this.elapsed - this.stateChangedAt) / 900)
    ctx.textBaseline = 'alphabetic'
    ctx.font = `10px ${MONO}`
    ctx.fillStyle = DIM
    ctx.fillText('STATE', 20, h - 62)
    ctx.font = `700 22px ${MONO}`
    ctx.fillStyle = fresh > 0 ? mix(ACC2, '#ffffff', fresh) : ACC2
    ctx.fillText(`▸ ${this.stateName}`, 20, h - 36)
  }

  private drawLog(ctx: CanvasRenderingContext2D, w: number, h: number): void {
    const recent = this.log.slice(-LOG_VISIBLE)
    ctx.textAlign = 'right'
    ctx.textBaseline = 'alphabetic'
    ctx.font = `11px ${MONO}`
    const bottom = h - 76
    recent.forEach((line, i) => {
      const y = bottom - (recent.length - 1 - i) * 17
      const age = (this.elapsed - line.at) / 1000
      const alpha = Math.max(0.32, 1 - age / 24)
      ctx.fillStyle = withAlpha(logColor(line.kind), alpha)
      const text = `${clock(line.at)}  ${line.kind.toUpperCase().padEnd(7)} ${line.text}`
      ctx.fillText(text.length > 64 ? `…${text.slice(-63)}` : text, w - 20, y)
    })
    ctx.textAlign = 'left'
  }

  private drawFooter(ctx: CanvasRenderingContext2D, w: number, h: number): void {
    ctx.font = `10px ${MONO}`
    ctx.fillStyle = DIM
    ctx.textAlign = 'left'
    ctx.fillText(`frame ${this.frames} · ${clock(this.elapsed)} · ${this.eventCount} events · ${this.worldId}`, 20, h - 16)

    // Held-command readout: which way the last impulses are still carrying us.
    const chips: Array<[string, number]> = [
      ['◀', Math.max(0, -this.drive.x)],
      ['▲', Math.max(0, this.drive.z)],
      ['▼', Math.max(0, -this.drive.z)],
      ['▶', Math.max(0, this.drive.x)],
      ['⇅', Math.abs(this.drive.y)],
    ]
    ctx.textAlign = 'right'
    ctx.font = `12px ${MONO}`
    chips.forEach(([glyph, level], i) => {
      ctx.fillStyle = withAlpha(level > 0.02 ? ACC : DIM, level > 0.02 ? Math.min(1, 0.4 + level) : 0.25)
      ctx.fillText(glyph, w - 20 - (chips.length - 1 - i) * 20, h - 16)
    })
    ctx.textAlign = 'left'
  }

  private drawBeat(ctx: CanvasRenderingContext2D, w: number, h: number): void {
    // Commands arrive as a stream while a key is held, so flashing the whole
    // frame for each one leaves a permanently lit border that reads as an error
    // state. Held input is already evidenced by the drive chips, the moving grid
    // and the log; the full-frame receipt is reserved for discrete authored beats.
    if (this.beatKind === 'command') return
    const age = (this.elapsed - this.beatAt) / 520
    if (age < 0 || age > 1) return
    const fade = 1 - age
    ctx.strokeStyle = withAlpha(logColor(this.beatKind), fade * 0.9)
    ctx.lineWidth = 2
    ctx.strokeRect(1, 1, w - 2, h - 2)
    // A sweep line makes "the provider received your event" impossible to miss.
    const y = age * h
    const sweep = ctx.createLinearGradient(0, y - 26, 0, y + 26)
    sweep.addColorStop(0, 'rgba(255,255,255,0)')
    sweep.addColorStop(0.5, withAlpha(logColor(this.beatKind), fade * 0.16))
    sweep.addColorStop(1, 'rgba(255,255,255,0)')
    ctx.fillStyle = sweep
    ctx.fillRect(0, y - 26, w, 52)
  }
}

function logColor(kind: LogLine['kind']): string {
  if (kind === 'state') return ACC
  if (kind === 'command') return WARN
  if (kind === 'prompt') return ACC2
  return DIM
}

function withAlpha(hex: string, alpha: number): string {
  const [r, g, b] = rgb(hex)
  return `rgba(${r},${g},${b},${Math.max(0, Math.min(1, alpha)).toFixed(3)})`
}

function mix(a: string, b: string, t: number): string {
  const k = clamp(t, 0, 1)
  const [r1, g1, b1] = rgb(a)
  const [r2, g2, b2] = rgb(b)
  return `rgb(${Math.round(r1 + (r2 - r1) * k)},${Math.round(g1 + (g2 - g1) * k)},${Math.round(b1 + (b2 - b1) * k)})`
}

function rgb(hex: string): [number, number, number] {
  const n = parseInt(hex.replace('#', ''), 16)
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255]
}

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v
}

function hash(s: string): number {
  let h = 2166136261
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i)
    h = Math.imul(h, 16777619)
  }
  return h >>> 0
}

function fallbackNotice(): HTMLElement {
  const el = document.createElement('div')
  el.style.cssText = 'padding:16px;font:12px ui-monospace,Menlo,monospace;color:var(--err)'
  el.textContent = 'Mock provider needs a 2D canvas, and this browser did not give one.'
  return el
}

export class MockWorldProvider implements WorldModelProvider {
  readonly id = 'mock' as const
  readonly label = 'Mock (local canvas)'

  // Nothing to configure — that is the whole point of shipping this as the
  // default: the studio is usable the second it boots.
  isConfigured(): boolean {
    return true
  }

  // No network, so the probe is a statement of fact rather than a request.
  async probe(): Promise<WorldCapabilities> {
    return CAPABILITIES
  }

  async connect(options: WorldConnectOptions): Promise<WorldSession> {
    return new MockSession(options)
  }
}

/** Factory form, for call sites that would rather not write `new`. */
export function createMockWorldProvider(): WorldModelProvider {
  return new MockWorldProvider()
}
