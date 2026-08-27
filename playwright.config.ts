import { defineConfig, devices } from '@playwright/test'

/**
 * End-to-end against a real browser, a real server process and a real certificate.
 *
 * The example chat app IS the fixture, so the example cannot rot: if it breaks, this
 * fails. Chromium only - Safari cannot talk to a quiche-backed server (D11), and running
 * it here would produce a red suite that says nothing about our code.
 *
 * A flaky test here gets fixed or deleted, never wrapped in a retry loop, so `retries` is
 * zero on purpose (D28).
 */
/** Overridable, because 8080 is the most contended port on any developer's machine. */
const E2E_PORT = process.env.E2E_PORT ?? '8080'
const E2E_ORIGIN = `http://localhost:${E2E_PORT}`

export default defineConfig({
  testDir: './e2e',
  fullyParallel: false,
  retries: 0,
  workers: 1,
  timeout: 45_000,
  reporter: process.env.CI === undefined ? 'list' : 'github',
  use: {
    baseURL: E2E_ORIGIN,
    trace: 'retain-on-failure',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: {
    command: 'npm run e2e:server',
    url: `${E2E_ORIGIN}/cert-hash`,
    // Never reuse. With reuse on, any dev server already holding this port was accepted -
    // Playwright's readiness probe passes on any status from 200 to 403 - and the suite
    // then ran against an unrelated application, failing on selectors that never mention
    // the port. Starting our own costs a few seconds and cannot be wrong about what it is
    // testing. `E2E_PORT` moves the port if something else owns it.
    reuseExistingServer: false,
    timeout: 60_000,
    stdout: 'pipe',
    stderr: 'pipe',
  },
})
