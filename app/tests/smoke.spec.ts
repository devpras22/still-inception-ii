import { test, expect } from './fixtures'

// End-to-end smoke of the studio against a live HOSTED /v1 backend.
//
// This one needs credentials, unlike no-key.spec.ts which covers the offline
// path. There is no longer a Settings gate to get past, and the key is no longer
// read from VITE_ALAKAZAM_API_KEY — that variable was compiled into the bundle
// and shipped to every visitor. Configure the Alakazam provider in Settings (it
// persists to localStorage) or set ALAKAZAM_API_KEY before running this.
//
// Without that key the whole file skips. It used to fail instead, which meant a
// stranger who cloned the repo and ran the suite got a red result on the first
// try — from a test that was never going to pass without an account. The default
// path is keyless; the test that needs a key has to say so itself.
// Declared rather than pulled in from @types/node: this file needs two env
// reads, and that is not worth a dependency in a repo whose pitch is how few
// there are. Playwright runs the spec under Node, so `process` is there.
declare const process: { env: Record<string, string | undefined> }

const API_KEY = process.env["ALAKAZAM_API_KEY"] || ''
const API_BASE = process.env["ALAKAZAM_API_BASE"] || 'https://api.alakazam.gg'

test.describe('hosted backend', () => {
  test.skip(!API_KEY, 'set ALAKAZAM_API_KEY to run the hosted smoke')

  // Point the studio at the hosted provider before any app code runs, so the
  // first render already reads /v1 rather than the local store.
  test.beforeEach(async ({ context }) => {
    await context.addInitScript(([key, base]) => {
      localStorage.setItem('alakazam-studio:config:v1', JSON.stringify({
        apiBase: base, embedHost: 'https://play.alakazam.gg', apiKey: key,
      }))
      localStorage.setItem('alakazam-studio:providers:v1', JSON.stringify({
        world: { active: 'alakazam', alakazam: { apiBase: base, embedHost: 'https://play.alakazam.gg', apiKey: key } },
      }))
    }, [API_KEY, API_BASE])
  })

  test('studio boots, lists worlds from /v1, and opens the graph editor', async ({ page }) => {
  await page.goto('/')

  // Shell renders unconditionally now; what this test proves is that data
  // arrives from /v1 rather than the local store.
  await expect(page.getByText('ALAKAZAM STUDIO')).toBeVisible()
  await expect(page.getByRole('heading', { name: 'My Creations' })).toBeVisible()

  // The API-call log proves data came from /v1.
  await expect(page.locator('.apilog-path', { hasText: '/v1/worlds' }).first()).toBeVisible({ timeout: 15_000 })

  // Either at least one world card, or the empty state — both are valid.
  const card = page.locator('.world-card').first()
  const empty = page.locator('.empty')
  await expect(card.or(empty)).toBeVisible({ timeout: 15_000 })

  const hasCard = await card.count()
  test.skip(hasCard === 0, 'no worlds on this app yet — create one to exercise the editor')

  // Open the graph editor and confirm the graph + tabs render.
  await card.getByRole('button', { name: 'Edit' }).click()
  await expect(page.getByRole('button', { name: 'Close' })).toBeVisible()
  await expect(page.getByRole('button', { name: 'Inspector' })).toBeVisible()
  await expect(page.getByRole('button', { name: 'Vision' })).toBeVisible()
  // A graph node (SVG text) should appear once /scene loads.
  await expect(page.locator('svg text').first()).toBeVisible({ timeout: 15_000 })
  })
})

// Needs no credentials: the shell must survive every rail click on the default
// keyless path, so it stays outside the hosted describe.
test('every navigation section renders without error', async ({ page }) => {
  await page.goto('/')
  // The RAIL'S OWN LABELS. This asked for a button named 'Create', which matched
  // nothing: the composer pill's accessible name is its aria-label ("Open the
  // floating world composer"), not its visible "+ Create a new world". The test
  // had been failing for that reason and nobody saw it, because `test:e2e`
  // named three spec files and this was not one of them — a spec outside the
  // gate is decoration. It is in the gate now, so this list must stay true.
  for (const name of ['My Creations', 'Book → Game', 'Community', 'Account', 'API']) {
    await page.getByRole('button', { name, exact: false }).first().click()
    // No uncaught error boundary / blank crash — the rail item stays and content is present.
    await expect(page.locator('.content')).toBeVisible()
  }
})
