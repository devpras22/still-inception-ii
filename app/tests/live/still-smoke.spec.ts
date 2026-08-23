import { test, expect } from '@playwright/test'
import { readFileSync } from 'node:fs'

/** STILL — one billed boot: the live living room under the five photographs. */
declare const process: { env: Record<string, string | undefined> }

const WORLD_ID = readFileSync('../still/spec/world-id.txt', 'utf8').trim()
const KEY = process.env['REACTOR_API_KEY'] || ''
const OPENAI_KEY = process.env['OPENAI_API_KEY'] || ''
const GEMINI_KEY = process.env['GEMINI_API_KEY'] || ''

test('STILL live: the room is a real session, the photographs sit over it', async ({ page }) => {
  test.skip(!KEY || !OPENAI_KEY || !GEMINI_KEY, 'set REACTOR_API_KEY, OPENAI_API_KEY, GEMINI_API_KEY')
  page.on('pageerror', (e) => console.log('  [pageerror]', String(e).slice(0, 200)))

  await page.addInitScript((args: { bridge: string; key: string; openai: string; gemini: string }) => {
    try {
      localStorage.setItem('alakazam-studio:providers:v1', JSON.stringify({
        world: {
          active: 'reactor',
          reactor: { apiKey: args.key, mode: 'adventure' },
          websocket: { url: '', apiKey: '', protocol: 'raw' },
          alakazam: { apiBase: args.bridge, embedHost: 'https://play.alakazam.gg', apiKey: 'local' },
        },
        llm: { active: 'openai', endpoints: { openai: { baseUrl: 'https://api.openai.com/v1', apiKey: args.openai, model: 'gpt-4o-mini' } } },
        image: { geminiKey: args.gemini, model: 'gemini-3-pro-image' },
        vision: { endpoint: 'local', apiKey: '', localUrl: '' },
      }))
    } catch { /* storage refusal still gets a test */ }
  }, { bridge: 'http://localhost:8787', key: KEY, openai: OPENAI_KEY, gemini: GEMINI_KEY })

  await page.setViewportSize({ width: 1440, height: 810 })
  await page.goto(`/?play=${WORLD_ID}`)
  const overlay = page.locator('[aria-label="Play world"]')
  await expect(overlay).toBeVisible({ timeout: 60_000 })
  await expect(page.getByText('connecting…')).toHaveCount(0, { timeout: 90_000 })
  await expect(page.locator('.choice-card-photo')).toHaveCount(5, { timeout: 20_000 })
  console.log('[still-live] LIVE living room up — five photographs over it')

  // One pickup over the live room: clip, caption, instant return.
  await page.locator('.choice-card-photo').nth(3).click()
  await expect(page.locator('[data-cutscene="cut_mem_lake78"]')).toBeVisible({ timeout: 30_000 })
  await expect(page.locator('[data-cutscene="cut_mem_lake78"]')).toHaveCount(0, { timeout: 40_000 })
  await expect(page.locator('.choice-card-photo')).toHaveCount(5, { timeout: 20_000 })
  await expect(page.getByText('connecting…')).toHaveCount(0, { timeout: 20_000 })
  console.log('[still-live] VERDICT: memory played over the live room and returned instantly')
  await page.screenshot({ path: '/tmp/still-live-room.png' })
})
