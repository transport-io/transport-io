import { defineConfig, devices } from '@playwright/test'

/**
 * End-to-end against a real browser, a real server process and a real certificate.
 *
 * The example chat app IS the fixture, so the example cannot rot: if it breaks, this
 * fails. Chromium only — Safari cannot talk to a quiche-backed server (D11), and running
 * it here would produce a red suite that says nothing about our code.
 *
 * A flaky test here gets fixed or deleted, never wrapped in a retry loop, so `retries` is
 * zero on purpose (D28).
 */
export default defineConfig({
  testDir: './e2e',
  fullyParallel: false,
  retries: 0,
  workers: 1,
  timeout: 45_000,
  reporter: process.env['CI'] === undefined ? 'list' : 'github',
  use: {
    baseURL: 'http://localhost:8080',
    trace: 'retain-on-failure',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: {
    command: 'npm run e2e:server',
    url: 'http://localhost:8080/cert-hash',
    reuseExistingServer: process.env['CI'] === undefined,
    timeout: 60_000,
    stdout: 'pipe',
    stderr: 'pipe',
  },
})
