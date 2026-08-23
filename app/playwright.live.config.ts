import { defineConfig } from '@playwright/test'

/**
 * Live-credential verification, recorded.
 *
 * SEPARATE from the default suite on purpose. These tests need real keys and a
 * real Reactor session is billed per second, so they must never run as part of
 * `npm test`. Run them deliberately:
 *
 *   REACTOR_API_KEY=... CEREBRAS_API_KEY=... \
 *     npx playwright test --config=playwright.live.config.ts
 *
 * Everything here is verified through the browser — clicking the studio's own
 * controls — rather than by calling an API from node. The point is to show the
 * product working, not the endpoint answering.
 *
 * `trace` is OFF deliberately. A trace records the arguments of every action,
 * which would write the API keys into an artifact meant to be shared. The video
 * is safe because the studio renders key fields as type="password".
 */
export default defineConfig({
  testDir: './tests/live',
  timeout: 180_000,
  workers: 1,
  reporter: [['list']],
  outputDir: './live-out',
  use: {
    baseURL: process.env.STUDIO_URL || 'http://localhost:4321',
    // Real Chrome, not the bundled Chromium. Reactor's video arrives over WebRTC
    // as H.264, and open-source Chromium builds ship without the proprietary
    // codecs — the track attaches, readyState stays 0 and the panel is black.
    // That is a codec gap in the test browser, not a defect in the studio, and
    // asserting against it would have condemned working software.
    channel: 'chrome',
    headless: true,
    trace: 'off',
    video: { mode: 'on', size: { width: 1440, height: 900 } },
    viewport: { width: 1440, height: 900 },
  },
  webServer: process.env.STUDIO_URL
    ? undefined
    : { command: 'npm run dev', url: 'http://localhost:4321', reuseExistingServer: true, timeout: 60_000 },
})
