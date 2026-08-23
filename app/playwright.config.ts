import { defineConfig } from '@playwright/test'

// E2E against the running studio (Vite dev on :4321), which drives the live /v1 API.
export default defineConfig({
  testDir: './tests',
  timeout: 180_000,
  fullyParallel: false,
  reporter: [['list']],
  /**
   * Each run keeps its OWN artifacts.
   *
   * Playwright empties `outputDir` at the start of every run, so a trace written
   * by a failing run is destroyed by the next one. That has cost this project
   * three times: a flake failed, two confirmation runs were fired to see whether
   * it reproduced, and both deleted the recording before anyone read it. The
   * instinct after a failure is to run it again, and the tooling punishes it.
   *
   * Nesting by timestamp means a re-run cannot erase the evidence of the run
   * that mattered. `test-results/` is gitignored, and CI globs the whole tree,
   * so nothing downstream cares which subdirectory a trace landed in.
   */
  outputDir: `test-results/${process.env.PW_RUN ?? new Date().toISOString().replace(/[:.]/g, '-')}`,
  use: { baseURL: process.env.STUDIO_URL || 'http://localhost:4321', headless: true },
  webServer: process.env.STUDIO_URL
    ? undefined
    : { command: 'npm run dev', url: 'http://localhost:4321', reuseExistingServer: true, timeout: 60_000 },
})
