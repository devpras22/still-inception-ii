#!/usr/bin/env node
/**
 * brand.mjs — regenerate the repository's front-page imagery.
 *
 * The README's pictures are the first thing anyone sees, and a hand-made banner
 * rots the same way a hand-written audit does: the product moves, the picture
 * does not, and nobody can tell. So the banner is BUILT — from the studio's own
 * theme tokens, in the studio's own vendored typeface, over a frame the studio
 * actually generated. Change the palette and re-run this; the banner follows.
 *
 * Two outputs, and the difference between them matters:
 *
 *   misc/banner.png   screenshot of misc/banner.template.html, into which this
 *                     script injects the live palette from `src/theme/styles.css`
 *   misc/editor.png   PHOTOGRAPHED — the live editor in a real browser, showing
 *                     the same world as `misc/play.png`, which is an archived
 *                     shot of a real Reactor session (that one cannot be
 *                     regenerated for free, so it is committed as an artifact
 *                     and its provenance is recorded in misc/README.md).
 *
 * Usage:
 *   npm run dev                      # the editor shot needs a server
 *   node scripts/brand.mjs           # both
 *   node scripts/brand.mjs --banner  # banner only, no server needed
 */
import { chromium } from '@playwright/test'
import { mkdirSync, readFileSync, existsSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const MISC = resolve(ROOT, 'misc')
const BASE = process.env.BASE ?? 'http://localhost:4321'
const only = process.argv.includes('--banner') ? 'banner' : process.argv.includes('--editor') ? 'editor' : 'both'

mkdirSync(MISC, { recursive: true })

/** The palette, read from the stylesheet rather than restated here. */
function tokens() {
  const css = readFileSync(resolve(ROOT, 'src/theme/styles.css'), 'utf8')
  const root = /:root\{([\s\S]*?)\n\}/.exec(css)?.[1] ?? ''
  const out = {}
  for (const m of root.matchAll(/--([a-z0-9-]+)\s*:\s*([^;]+);/g)) out[m[1]] = m[2].trim()
  const need = ['bg', 'ink', 'dim', 'acc', 'line', 'brand-ink', 'grid-line', 'grid-size', 'mono']
  const missing = need.filter((k) => !out[k])
  if (missing.length) throw new Error(`styles.css no longer defines: ${missing.join(', ')}`)
  return out
}

const W = 1500
const H = 500

/**
 * The palette and geometry the banner document needs, as CSS custom properties.
 *
 * The markup lives in misc/banner.template.html, not here. A document built as a
 * string inside a script is the thing `no-html-strings` exists to stop, and the
 * rule is right: the banner is now editable as HTML, and this function's whole
 * job is to hand it the real brand rather than a copy of it.
 */
function bannerVars(t) {
  // The frame's video region inside that 1280x800 capture, measured once. The
  // height stops at 664 rather than the video's true bottom edge: the player's
  // "type what happens next" pill floats over the last 40px, and a banner that
  // clips a control halfway reads as a broken screenshot rather than a frame.
  const CROP = { x: 16, y: 168, w: 896, h: 496 }
  const SOURCE_W = 1280
  const decl = [
    `--w:${W}px`,
    `--h:${H}px`,
    `--source-w:${SOURCE_W}px`,
    `--crop-x:${CROP.x}px`,
    `--crop-y:${CROP.y}px`,
    `--crop-w:${CROP.w}px`,
    `--crop-h:${CROP.h}px`,
    `--scale:${H / CROP.h}`,
    // Every token the template names, read live from the stylesheet.
    ...['bg', 'ink', 'dim', 'acc', 'line', 'brand-ink', 'grid-line', 'grid-size', 'mono'].map(
      (k) => `--tok-${k}:${t[k]}`,
    ),
  ]
  return `:root{${decl.join(';')}}`
}

const browser = await chromium.launch()

if (only !== 'editor') {
  if (!existsSync(resolve(MISC, 'play.png'))) {
    throw new Error('misc/play.png is missing — the banner is composed over it')
  }
  const page = await browser.newPage({ viewport: { width: W, height: H }, deviceScaleFactor: 2 })
  await page.goto(pathToFileURL(resolve(MISC, 'banner.template.html')).href)
  await page.addStyleTag({ content: bannerVars(tokens()) })
  await page.evaluate(() => document.fonts.ready)
  await page.waitForFunction(() => {
    const img = document.querySelector('.frame img')
    return img instanceof HTMLImageElement && img.complete && img.naturalWidth > 0
  })
  await page.screenshot({ path: resolve(MISC, 'banner.png') })
  await page.close()
  console.log('wrote misc/banner.png')
}

if (only !== 'banner') {
  // The editor, photographed against the same world the play shot shows.
  const fixture = process.env.WORLD_JSON ?? '/tmp/fixture-inner.json'
  if (!existsSync(fixture)) throw new Error(`no world to photograph: ${fixture} (set WORLD_JSON)`)
  const db = readFileSync(fixture, 'utf8')
  const id = JSON.parse(db).worlds?.[0]?.id
  if (!id) throw new Error(`${fixture} holds no world`)

  const ctx = await browser.newContext({ viewport: { width: 1440, height: Number(process.env.SHOT_H ?? 820) }, deviceScaleFactor: 2 })
  await ctx.addInitScript(
    ([key, blob, ftue]) => {
      try {
        localStorage.setItem(key, blob)
        localStorage.setItem(ftue, '1')
      } catch {
        /* a browser refusing storage still gets a page */
      }
    },
    ['alakazam-studio:worlds:v1', db, 'alakazam-studio:ftue:v1'],
  )
  const page = await ctx.newPage()
  const res = await page.goto(`${BASE}/?world=${id}`).catch(() => null)
  if (!res) throw new Error(`no dev server on ${BASE} — run "npm run dev" first`)
  await page.getByRole('button', { name: 'Inspector' }).waitFor({ timeout: 30000 })
  await page.getByRole('button', { name: /^state / }).first().click().catch(() => {})
  await page.waitForTimeout(800)

  // Compose the shot the way the editor's own controls do it, not by faking a
  // camera: the fit-on-load keeps a floor at READABLE zoom, so a five-state
  // graph legitimately overflows the pane. Zoom out (the editor's wheel) and
  // then centre (the minimap's keyboard move) until every node is on screen.
  const canvas = page.locator('.graph-pane, .graph-canvas, .graph').first()
  const box = (await canvas.boundingBox().catch(() => null)) ?? { x: 500, y: 500, width: 0, height: 0 }
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
  const NOTCHES = Number(process.env.NOTCHES ?? 2)
  for (let i = 0; i < NOTCHES; i += 1) {
    await page.mouse.wheel(0, 240)
    await page.waitForTimeout(120)
  }
  await page.getByRole('button', { name: /minimap/i }).focus().catch(() => {})
  await page.keyboard.press('Enter').catch(() => {})
  await page.waitForTimeout(900)
  await page.screenshot({ path: resolve(MISC, 'editor.png'), animations: 'disabled' })
  await ctx.close()
  console.log('wrote misc/editor.png')
}

await browser.close()
