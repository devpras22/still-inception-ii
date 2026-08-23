import { test, expect } from '@playwright/test'

/**
 * Records the studio actually being used, so the release video can show the
 * product instead of describing it. Each test is one beat and produces one
 * video file; the build script crops and drops them into the left panel.
 *
 * Recorded at 1440x900 and scaled down later — recording at the panel's own
 * size would give a cramped viewport that no real user has.
 *
 * Every beat starts from an empty browser profile, because the first-run
 * experience with no key IS the thing being demonstrated.
 */

test.use({
  viewport: { width: 1440, height: 900 },
  video: { mode: 'on', size: { width: 1440, height: 900 } },
})

/** Let a beat breathe — a cut that lands mid-animation reads as a glitch. */
const beat = (ms: number) => new Promise((r) => setTimeout(r, ms))

test('01 boots with no key', async ({ page }) => {
  await page.goto('/')
  await expect(page.getByText('ALAKAZAM STUDIO')).toBeVisible()
  await beat(1200)
  // Linger on the pills — "world · mock" and "worlds · this browser" are the
  // proof that nothing is configured and it still works.
  await page.getByRole('button', { name: /My Creations/ }).hover()
  await beat(1500)
  await page.getByRole('button', { name: /Community/ }).hover()
  await beat(900)
  await page.getByRole('button', { name: /My Creations/ }).click()
  await beat(1800)
})

test('02 create a world offline', async ({ page }) => {
  await page.goto('/')
  await page.getByRole('button', { name: /Create/ }).click()
  await beat(900)
  const input = page.locator('input[type="text"], textarea').first()
  // Type it out rather than fill() — the point is to look like a person using it.
  await input.click()
  await input.pressSequentially('a quiet street at dusk, someone waiting', { delay: 45 })
  await beat(1200)
  await page.getByRole('button', { name: /^(Create|New|Blank|Start)/ }).first().click()
  await expect(page.locator('.overlay svg').first()).toBeVisible({ timeout: 30_000 })
  await beat(2200)
})

test('03 the graph', async ({ page }) => {
  await page.goto('/')
  await page.getByRole('button', { name: /Create/ }).click()
  await page.locator('input[type="text"], textarea').first().fill('a quiet street at dusk')
  await page.getByRole('button', { name: /^(Create|New|Blank|Start)/ }).first().click()

  const graph = page.locator('.overlay svg').first()
  await expect(graph).toBeVisible({ timeout: 30_000 })
  await beat(1500)

  // Move over the graph so nodes/edges get hover states — a still graph looks
  // like a screenshot, a graph reacting to a cursor looks like a tool.
  const box = await graph.boundingBox()
  if (box) {
    const cx = box.x + box.width / 2
    const cy = box.y + box.height / 2
    for (const [dx = 0, dy = 0] of [[-160, -60], [140, -30], [60, 90], [-120, 70], [0, 0]]) {
      await page.mouse.move(cx + dx, cy + dy, { steps: 22 })
      await beat(420)
    }
  }
  await beat(1200)
})

test('04 settings, bring your own', async ({ page }) => {
  await page.goto('/')
  await page.getByRole('button', { name: 'Settings' }).click()
  await beat(1400)
  // Walk the world providers so the viewer sees there is a real choice.
  // Just scroll the panel — selectOption() blocked here last time and burned the
  // whole beat on a timeout.
  await beat(1200)
  await page.mouse.wheel(0, 400)
  await beat(1600)
})

test('05 play the mock world', async ({ page }) => {
  await page.goto('/')
  await page.getByRole('button', { name: /Create/ }).click()

  // Play the EXAMPLE world, not a one-state world made from a premise: it is
  // the only one with authored events, so it is the only one where the beat
  // rail has anything in it. The previous take filmed a world with nothing to
  // send, at a time when the studio could not send anything anyway — the mock
  // was drawing "no prompt — the studio sent none for this world" straight into
  // the shot.
  await page.getByRole('button', { name: /Open the example world/ }).click()
  await expect(page.locator('.overlay svg').first()).toBeVisible({ timeout: 30_000 })

  await page.getByRole('button', { name: 'Close' }).first().click()
  await page.getByRole('button', { name: /My Creations/ }).click()
  const play = page.locator('.world-card').first().getByRole('button', { name: /Play/ })
  if (await play.count()) {
    await play.click()
    await beat(2500)
    // Push an authored beat, on camera.
    const send = page.getByRole('button', { name: /walk up the lane/i })
    if (await send.count()) {
      await send.click()
      await beat(4000)
    } else {
      await beat(4000)
    }
  }
})
