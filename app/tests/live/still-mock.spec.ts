import { test, expect, type Page } from '@playwright/test'
import { readFileSync } from 'node:fs'

/**
 * STILL — the whole film on the free mock provider, through the photograph
 * door: begin arms sound, three prints sit in the shoebox, picking one up
 * ZOOMS THE PRINT into the memory's live world (no clip — the session boots
 * from the same picture), one put-it-back card returns, the emptied box turns
 * the room into the deck (piano wall, then bookshelf), and the last one ends
 * the film on the STILL card.
 */
declare const process: { env: Record<string, string | undefined> }

const WORLD_ID = readFileSync('../still/spec/world-id.txt', 'utf8').trim()

async function throughDoor(page: Page, line: string): Promise<void> {
  const door = page.locator('.zoom-door')
  await expect(door).toBeVisible({ timeout: 20_000 })
  // The door fades only once the memory's session is standing.
  await expect(door).toHaveCount(0, { timeout: 40_000 })
  // One continuous spoken line: the memory, then the present tense.
  await expect(page.locator('.narration')).toContainText(line, { timeout: 20_000 })
}

test('STILL: begin → shoebox → through the photographs → the room itself → album', async ({ page }) => {
  await page.addInitScript((args: { bridge: string }) => {
    try {
      localStorage.setItem('alakazam-studio:providers:v1', JSON.stringify({
        world: {
          active: 'mock',
          reactor: { apiKey: '', mode: 'adventure' },
          websocket: { url: '', apiKey: '', protocol: 'raw' },
          alakazam: { apiBase: args.bridge, embedHost: 'https://play.alakazam.gg', apiKey: 'local' },
        },
        llm: { active: 'openai', endpoints: { openai: { baseUrl: 'https://api.openai.com/v1', apiKey: 'sk-mock', model: 'gpt-4o-mini' } } },
        image: { geminiKey: 'mock', model: 'gemini-3-pro-image' },
        vision: { endpoint: 'local', apiKey: '', localUrl: '' },
      }))
    } catch { /* storage refusal still gets a test */ }
  }, { bridge: 'http://localhost:8787' })

  await page.setViewportSize({ width: 1440, height: 810 })
  await page.goto(`/?play=${WORLD_ID}`)
  const overlay = page.locator('[aria-label="Play world"]')
  await expect(overlay).toBeVisible({ timeout: 60_000 })

  // The title card waits: begin arms the film's sound.
  await expect(page.locator('.title-card')).toBeVisible({ timeout: 20_000 })
  await page.getByRole('button', { name: '▶ begin' }).click()
  await expect(page.getByText('connecting…')).toHaveCount(0, { timeout: 60_000 })
  await expect(page.locator('.narration')).toContainText('pick one up', { timeout: 20_000 })
  console.log('[still] begun — Ellen speaks over the room')

  // THREE prints in the shoebox, tucked into the corner.
  const photos = page.locator('.choice-card-photo')
  await expect(photos).toHaveCount(3, { timeout: 20_000 })
  await expect(page.locator('.story-hud')).toContainText('STILL')
  console.log('[still] three prints in the shoebox')

  // Each pickup: the print zooms into ITS world, one card returns.
  const boxOrder = [
    ['The hat', 'always thought the wind'],
    ['let go', 'Go on — ride'],
    ['Three hundred cookies', 'Smell that'],
  ] as const
  for (const [memory, present] of boxOrder) {
    await page.locator('.choice-card-photo').first().click()
    await throughDoor(page, memory)
    await expect(page.locator('.narration')).toContainText(present)
    const deck = page.locator('.choice-card')
    await expect(deck).toHaveCount(1, { timeout: 20_000 })
    await expect(deck.first()).toContainText('put it back in the box')
    console.log(`[still] through the ${memory.toLowerCase()} print — standing inside it`)
    await deck.first().click()
    // Coming home is its own line, a different one per photograph.
    if (memory === 'The hat') {
      await expect(page.locator('.narration')).toContainText("forgotten that hat", { timeout: 20_000 })
      console.log('[still] home again — a fresh line, not the opening speech')
    }
  }
  await expect(photos).toHaveCount(0, { timeout: 20_000 })
  console.log('[still] shoebox empty')

  // The box empties → the room becomes the deck.
  const boxDone = page.locator('.choice-card', { hasText: 'the shoebox is empty' })
  await expect(boxDone).toBeVisible({ timeout: 20_000 })
  await boxDone.click()
  await expect(page.locator('.narration')).toContainText('keep everything', { timeout: 20_000 })
  await expect(photos).toHaveCount(1, { timeout: 20_000 })
  console.log('[still] the room itself — wall photograph up, shelf locked behind it')

  // The wall: 1978 above the piano, then back to the room.
  await photos.first().click()
  await throughDoor(page, 'One rod')
  await expect(page.locator('.narration')).toContainText('still the water')
  const back = page.locator('.choice-card', { hasText: 'put it back on the wall' })
  await expect(back).toBeVisible({ timeout: 20_000 })
  await back.click()

  // The shelf appears only now — the last one — and ends the film.
  await expect(photos).toHaveCount(1, { timeout: 20_000 })
  await photos.first().click()
  await throughDoor(page, 'the same time')
  const last = page.locator('.choice-card', { hasText: 'put it down' })
  await expect(last).toBeVisible({ timeout: 20_000 })
  await last.click()
  await expect(page.locator('.ending-card')).toBeVisible({ timeout: 60_000 })
  await expect(page.locator('.ending-card')).toContainText('STILL')
  console.log('[still] VERDICT: box → room → last photograph → album card')

  await page.screenshot({ path: '/tmp/still-ending.png' })
})
