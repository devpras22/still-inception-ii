/**
 * The browser every spec here starts from.
 *
 * One thing is seeded and nothing else: the editor's first-run tour is marked
 * SEEN. Every test in this suite is about a returning author — someone who has
 * opened the studio before and came back to do a thing — and a first-run scrim
 * over the editor is a scrim over all of them.
 *
 * That is not hypothetical. Adding the tour took the full suite from about a
 * minute to FIFTEEN, every editor test waiting out its own timeout behind a
 * modal. The first fix set the flag inside one spec file, which fixed one spec
 * file: the other three kept paying. A first-run surface is a global
 * precondition, so the seam that skips it has to be global too — here, so a
 * fifth spec cannot be written without it.
 *
 * The tour's OWN test opts back out by registering a later init script that
 * removes the flag (init scripts run in registration order, so the last write
 * wins). That keeps first-run behaviour asserted in exactly one place.
 */
import { test as base } from '@playwright/test'

export const FTUE_SEEN_KEY = 'alakazam-studio:ftue:v1'

export const test = base.extend({
  page: async ({ page }, use) => {
    await page.addInitScript((key) => {
      try {
        localStorage.setItem(key, '1')
      } catch {
        /* a browser refusing storage still gets a working test */
      }
    }, FTUE_SEEN_KEY)
    await use(page)
  },
})

export { expect } from '@playwright/test'
