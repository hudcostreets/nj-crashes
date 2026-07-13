import { defineConfig } from '@playwright/test'

export default defineConfig({
  testDir: './e2e',
  timeout: 30_000,
  // A ~4% residual flake on the legend-ux click-to-pin tests (see the
  // `clickNativeLegendItem` helper's docstring for the Playwright/Chromium
  // mouseup quirk we work around) makes 1 retry the difference between
  // "reliable CI" and "wastes ~1 in 25 CI runs". Keep to 1 so real
  // regressions still surface promptly.
  retries: 1,
  use: {
    baseURL: process.env.PLAYWRIGHT_BASE_URL ?? 'http://localhost:4006',
    headless: true,
    viewport: { width: 1280, height: 900 },
  },
  webServer: process.env.PLAYWRIGHT_BASE_URL ? undefined : {
    command: 'pnpm dev',
    port: 4006,
    reuseExistingServer: true,
    timeout: 30_000,
  },
  projects: [
    { name: 'chromium', use: { browserName: 'chromium' } },
  ],
})
