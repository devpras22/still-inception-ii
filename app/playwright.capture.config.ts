import { defineConfig } from '@playwright/test'
export default defineConfig({
  testDir: './tests/capture', timeout: 120_000, workers: 1, reporter: [['list']],
  outputDir: './capture-out',
  use: { baseURL: 'http://localhost:4321', headless: true },
  webServer: { command: 'npm run dev', url: 'http://localhost:4321', reuseExistingServer: true, timeout: 60_000 },
})
