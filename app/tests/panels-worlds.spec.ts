import { test, expect } from './fixtures'
import type { Page } from '@playwright/test'

/**
 * Functional coverage for the three panels that manage a world's LIFECYCLE
 * once it exists: My Creations (fork, visibility, delete), Community (the
 * read-only public gallery) and Account (the honest keyless dead end).
 *
 * Every test seeds its own world — the starter example, reached the same way
 * a real visitor reaches it (Create → "Open the example world" → Close) — so
 * nothing here depends on test order or a shared fixture world. Each test
 * gets Playwright's usual fresh, empty browser context.
 */

/** Create the starter world and land back on My Creations, exactly the path
 *  a keyless visitor uses. Every test that needs "at least one card" starts here. */
async function seedExampleWorld(page: Page): Promise<void> {
  await page.goto('/')
  await page.getByRole('button', { name: 'Open the floating world composer' }).click()
  await page.getByRole('button', { name: /Open the example world/ }).click()
  await expect(page.getByRole('button', { name: 'Inspector' })).toBeVisible({ timeout: 15_000 })
  await page.getByRole('button', { name: 'Close' }).first().click()
  await page.getByRole('button', { name: /My Creations/ }).click()
}

test('fork writes the store and survives a reload', async ({ page }) => {
  await seedExampleWorld(page)

  const cards = page.locator('.world-card')
  const before = await cards.count()

  await cards.first().getByRole('button', { name: 'Fork' }).click()
  await expect.poll(() => cards.count(), { timeout: 15_000 }).toBe(before + 1)

  // A genuine write, not component state: a full reload re-reads the store
  // from scratch and the fork is still there.
  await page.goto('/')
  await page.getByRole('button', { name: /My Creations/ }).click()
  await expect.poll(() => cards.count(), { timeout: 15_000 }).toBe(before + 1)
})

test('visibility cycles and persists', async ({ page }) => {
  await seedExampleWorld(page)

  const badge = page.locator('.world-card').first().locator('.badge')
  await expect(badge).toHaveText('private')

  await badge.click()
  await expect(badge).toHaveText('unlisted', { timeout: 10_000 })

  await badge.click()
  await expect(badge).toHaveText('public', { timeout: 10_000 })

  // Not component state: a fresh load re-reads the same visibility from the store.
  await page.goto('/')
  await page.getByRole('button', { name: /My Creations/ }).click()
  await expect(page.locator('.world-card').first().locator('.badge')).toHaveText('public')
})

test('delete confirms, and a dismissed dialog deletes nothing', async ({ page }) => {
  await seedExampleWorld(page)
  // A second world so the confirmed branch still leaves a card to look at.
  await page.locator('.world-card').first().getByRole('button', { name: 'Fork' }).click()

  const cards = page.locator('.world-card')
  await expect.poll(() => cards.count(), { timeout: 15_000 }).toBe(2)
  const before = await cards.count()

  // Exactly ONE dialog per click. A migration briefly had both DangerButton and
  // the delete handler calling window.confirm, so every delete asked twice —
  // this count is the regression pin for that class of bug.
  let dialogs = 0

  // Dismissed: the dialog is cancelled, so the delete never fires.
  const dismissAll = (d: import('@playwright/test').Dialog) => { dialogs += 1; void d.dismiss() }
  page.on('dialog', dismissAll)
  await cards.first().getByRole('button', { name: 'Delete' }).click()
  await page.waitForTimeout(500)
  await expect(cards).toHaveCount(before)
  page.off('dialog', dismissAll)
  expect(dialogs).toBe(1)

  // Confirmed: the dialog is accepted, and the card is gone.
  dialogs = 0
  const acceptAll = (d: import('@playwright/test').Dialog) => { dialogs += 1; void d.accept() }
  page.on('dialog', acceptAll)
  await cards.first().getByRole('button', { name: 'Delete' }).click()
  await expect.poll(() => cards.count(), { timeout: 15_000 }).toBe(before - 1)
  page.off('dialog', acceptAll)
  expect(dialogs).toBe(1)
})

test('community is honest when empty, and a public world appears', async ({ page }) => {
  await page.goto('/?section=community')
  await expect(page.getByRole('heading', { name: 'Community' })).toBeVisible()

  // Keyless, this is a filtered read of the SAME local store My Creations
  // uses — not a call pretending there is a hosted backend to load from.
  await expect(page.getByText('No public worlds yet.')).toBeVisible({ timeout: 15_000 })
  await expect(page.locator('.diag.error')).toHaveCount(0)

  await seedExampleWorld(page)
  const badge = page.locator('.world-card').first().locator('.badge')
  await badge.click()
  await expect(badge).toHaveText('unlisted', { timeout: 10_000 })
  await badge.click()
  await expect(badge).toHaveText('public', { timeout: 10_000 })

  await page.getByRole('button', { name: /Community/ }).click()
  await expect(page.getByText('No public worlds yet.')).toHaveCount(0)
  const publicCard = page.locator('.world-card').first()
  await expect(publicCard).toBeVisible({ timeout: 15_000 })
  await expect(publicCard.getByRole('button', { name: 'Play' })).toBeVisible()
})

test('account is honest keyless: no fetch, an explanation instead', async ({ page }) => {
  // Match on HOST, not on the URL string — see no-key.spec.ts for why: the dev
  // server itself serves paths containing vendor-looking substrings.
  const vendor: string[] = []
  page.on('request', (r) => {
    let host = ''
    try { host = new URL(r.url()).hostname } catch { return }
    if (host === 'localhost' || host === '127.0.0.1' || host === '[::1]') return
    vendor.push(`${host} ${r.url()}`)
  })

  await page.goto('/?section=account')
  await expect(page.getByRole('heading', { name: 'Account' })).toBeVisible()
  await expect(page.getByText(/Nothing is fetched until you add a key/i)).toBeVisible()

  await page.waitForTimeout(1000)
  expect(vendor).toEqual([])
})
