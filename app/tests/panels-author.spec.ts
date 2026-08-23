import { test, expect } from './fixtures'
import type { Page } from '@playwright/test'

/**
 * Functional coverage for the editor panels that do not manage the world's
 * lifecycle (that's panels-worlds.spec.ts) but its CONTENT and its doctrine
 * gates: Versions (snapshot / diff / checkout / prune), Validate & Lint (the
 * fail-closed gate and its advisory sibling) and Vision (the hosted,
 * key-gated, differentiator panel).
 *
 * Every test seeds its own world — the starter example, reached the same way
 * a real visitor reaches it (Create → "Open the example world") — and every
 * test runs keyless, in a fresh, empty browser context. Nothing here depends
 * on test order or a shared fixture world.
 */

/** Create the starter world and land on the editor (default tab: Inspector),
 *  returning its id straight out of the URL the editor just wrote. */
async function seedExampleWorld(page: Page): Promise<string> {
  await page.goto('/')
  await page.getByRole('button', { name: 'Open the floating world composer' }).click()
  await page.getByRole('button', { name: /Open the example world/ }).click()
  await expect(page.getByRole('button', { name: 'Inspector' })).toBeVisible({ timeout: 15_000 })
  const worldId = new URL(page.url()).searchParams.get('world')
  expect(worldId).toBeTruthy()
  return worldId ?? ''
}

test('a version round-trips through the panel: snapshot, edit, restore, and the auto-backup exists', async ({ page }) => {
  const worldId = await seedExampleWorld(page)

  await page.goto(`/?world=${worldId}&tab=versions`)
  await expect(page.getByRole('heading', { name: 'Versions' })).toBeVisible({ timeout: 15_000 })

  // Snapshot the untouched graph, named so Checkout below can find it again.
  await page.getByPlaceholder('Title (optional)').fill('before')
  await page.getByRole('button', { name: 'Snapshot current' }).click()
  await expect(page.getByText('snapshot saved')).toBeVisible({ timeout: 10_000 })
  const rowsBefore = await page.locator('.card').count()
  expect(rowsBefore).toBeGreaterThan(0)

  // Switch to Inspector, select the lane state, and rewrite its base prompt.
  await page.getByRole('button', { name: 'Inspector', exact: true }).click()
  await page.locator('svg text').filter({ hasText: /^lane$/ }).first().click()
  const prompt = page.getByPlaceholder(/What the camera sees/).first()
  const original = await prompt.inputValue()
  expect(original.length).toBeGreaterThan(0)

  await prompt.fill('A completely rewritten lane, nothing like the original prose.')
  await page.getByRole('button', { name: /Save state/ }).click()
  await expect(page.getByText('State saved')).toBeVisible({ timeout: 10_000 })
  await expect(prompt).toHaveValue('A completely rewritten lane, nothing like the original prose.')

  // Back to Versions, check the 'before' snapshot out over the edit.
  await page.getByRole('button', { name: 'Versions', exact: true }).click()
  const beforeRow = page.locator('.card', { hasText: 'before' })
  page.once('dialog', (d) => { void d.accept() })
  await beforeRow.getByRole('button', { name: 'Checkout' }).click()
  await expect(page.getByText(/checked out/)).toBeVisible({ timeout: 15_000 })

  // The restore's own safety net: a backup of the (edited) graph taken right
  // before the overwrite, so the version tree grew by one and carries the tag.
  await expect.poll(() => page.locator('.card').count(), { timeout: 10_000 }).toBe(rowsBefore + 1)
  await expect(page.getByText('pre-restore')).toBeVisible()

  // And the lane base prompt really is back to what it was before the edit.
  await page.getByRole('button', { name: 'Inspector', exact: true }).click()
  await page.locator('svg text').filter({ hasText: /^lane$/ }).first().click()
  await expect(prompt).toHaveValue(original)
})

test('prune asks, and a dismissed dialog prunes nothing', async ({ page }) => {
  const worldId = await seedExampleWorld(page)

  await page.goto(`/?world=${worldId}&tab=versions`)
  await expect(page.getByRole('heading', { name: 'Versions' })).toBeVisible({ timeout: 15_000 })

  // Two snapshots, so the one we prune is not HEAD — pruning HEAD is a
  // separate, already-guaranteed 409 refusal, not what this test is about.
  await page.getByPlaceholder('Title (optional)').fill('one')
  await page.getByRole('button', { name: 'Snapshot current' }).click()
  await expect(page.getByText('snapshot saved')).toBeVisible({ timeout: 10_000 })
  await page.getByPlaceholder('Title (optional)').fill('two')
  await page.getByRole('button', { name: 'Snapshot current' }).click()
  await expect(page.getByText('snapshot saved')).toBeVisible({ timeout: 10_000 })

  const rows = page.locator('.card')
  await expect(rows).toHaveCount(2)
  const row = page.locator('.card', { hasText: 'one' })

  // Dismissed: the dialog fired (it named the version) and nothing happened.
  let asked = ''
  page.once('dialog', (d) => { asked = d.message(); void d.dismiss() })
  await row.getByRole('button', { name: 'Prune' }).click()
  expect(asked).toMatch(/prune version/i)
  await expect(rows).toHaveCount(2)
  await expect(page.getByText('one', { exact: true })).toBeVisible()

  // Accepted: the row is actually gone.
  page.once('dialog', (d) => { void d.accept() })
  await row.getByRole('button', { name: 'Prune' }).click()
  await expect.poll(() => rows.count(), { timeout: 10_000 }).toBe(1)
  await expect(page.getByText('one', { exact: true })).toHaveCount(0)
})

test('validate and lint RUN offline against the local doctrine, and judge honestly', async ({ page }) => {
  const worldId = await seedExampleWorld(page)

  await page.goto(`/?world=${worldId}&tab=validate`)
  await expect(page.getByRole('heading', { name: 'Validate & Lint' })).toBeVisible({ timeout: 15_000 })

  // These used to report "unavailable" with no key — honest, but it meant a
  // world authored entirely offline was never checked at all. The doctrine now
  // runs locally, so the gate gives a real verdict here. What must NOT come
  // back is the old failure mode in reverse: a pass that was never computed.
  await page.getByRole('button', { name: 'Validate' }).last().click()
  await expect(page.getByText(/^(valid|invalid)$/)).toBeVisible({ timeout: 10_000 })
  await expect(page.getByText(/reported as unavailable rather than as a pass/i)).toHaveCount(0)

  // The shipped example world is clean, so the gate should say so — and say it
  // because it checked, not because it could not.
  await expect(page.getByText('valid', { exact: true })).toBeVisible()
  await expect(page.getByText(/passes the gate/i)).toBeVisible()

  // The advisory pass is a DIFFERENT verdict from the gate, and the shipped
  // world exercises exactly that difference: it is valid (nothing blocks play)
  // and it carries one warning (an anchor with no minimum on-screen size),
  // which the starter world holds on purpose so the rule and its one-click fix
  // are visible on the first world anyone opens.
  await page.getByRole('button', { name: 'Lint', exact: true }).click()
  await expect(page.getByText(/sliver-evidence|minimum on-screen size|cut off at the frame edge/i).first())
    .toBeVisible({ timeout: 10_000 })
})

test('a world the doctrine rejects is called invalid, with the failing field named', async ({ page }) => {
  const worldId = await seedExampleWorld(page)

  // Author a negation into a state's prose — the doctrine's first rule, and the
  // one that matters most for a world model: it renders what it reads.
  await page.goto(`/?world=${worldId}&sel=state:lane`)
  await expect(page.getByRole('button', { name: /Save state/ })).toBeVisible({ timeout: 15_000 })
  await page.locator('#insp-state-base').fill('A lane between low stone walls. There are no birds here.')
  await page.getByRole('button', { name: /Save state/ }).click()
  await page.waitForTimeout(800)

  await page.goto(`/?world=${worldId}&tab=validate`)
  await page.getByRole('button', { name: 'Validate' }).last().click()
  await expect(page.getByText('invalid', { exact: true })).toBeVisible({ timeout: 10_000 })
  await expect(page.getByText(/negation/i).first()).toBeVisible()
})

test('the vision panel keeps frames on the machine when keyless', async ({ page }) => {
  // Fail-and-record any request that would leave the machine. Vision's whole
  // point is a frame going somewhere; on a keyless clone that somewhere must
  // not exist, so this aborts anything that isn't the dev server itself.
  const vendorRequests: string[] = []
  const localHosts = new Set(['localhost', '127.0.0.1', '[::1]', ''])
  const localProtocols = new Set(['data:', 'blob:', 'about:'])
  await page.route('**/*', async (route) => {
    const url = route.request().url()
    let parsed: URL
    try {
      parsed = new URL(url)
    } catch {
      await route.continue()
      return
    }
    if (localProtocols.has(parsed.protocol) || localHosts.has(parsed.hostname)) {
      await route.continue()
      return
    }
    vendorRequests.push(url)
    await route.abort()
  })

  const worldId = await seedExampleWorld(page)

  await page.getByRole('button', { name: 'Vision', exact: true }).click()
  await expect(page.getByRole('heading', { name: 'Vision' })).toBeVisible({ timeout: 15_000 })

  // Hosted actions, disabled with a reason — not just disabled, but honest
  // about why: no key means no call, stated up front rather than after a 401.
  const perceiveBtn = page.getByRole('button', { name: 'Perceive' })
  const detectBtn = page.getByRole('button', { name: 'Detect' })
  await expect(perceiveBtn).toBeDisabled()
  await expect(detectBtn).toBeDisabled()
  await expect(perceiveBtn).toHaveAttribute('title', /not available offline/i)
  await expect(detectBtn).toHaveAttribute('title', /not available offline/i)

  // Give any stray request time to fire while the panel is mounted and idle.
  await page.waitForTimeout(1500)
  expect(vendorRequests).toEqual([])

  // worldId only exists to prove the seed actually ran under this world.
  expect(worldId).toBeTruthy()
})
