import { test, expect } from '@playwright/test'

test.use({ viewport: { width: 1440, height: 900 }, video: { mode: 'on', size: { width: 1440, height: 900 } } })
const beat = (ms: number) => new Promise((r) => setTimeout(r, ms))

test('the example graph', async ({ page }) => {
  await page.goto('/')
  await page.getByRole('button', { name: /Create/ }).click()
  await beat(700)
  await page.getByRole('button', { name: /Open the example world/ }).click()

  const graph = page.locator('.overlay svg').first()
  await expect(graph).toBeVisible({ timeout: 30_000 })
  await beat(1600)

  // Drift the cursor over the nodes so edges and cards light up — a still graph
  // photographs as a screenshot, a reacting one reads as a tool.
  const box = await graph.boundingBox()
  if (box) {
    const cx = box.x + box.width / 2
    const cy = box.y + box.height / 2
    for (const [dx = 0, dy = 0] of [[-200, -40], [0, -60], [200, 20], [40, 110], [-160, 80], [0, 0]]) {
      await page.mouse.move(cx + dx, cy + dy, { steps: 26 })
      await beat(520)
    }
  }
  await beat(1400)
})
