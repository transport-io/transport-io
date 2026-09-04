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
/**
 * `transport-io dev --demo` runs alongside the example, on its own ports.
 *
 * The demo is the only thing that meets the acceptance test for `dev` - someone who has
 * never used this library seeing two tabs talk after one command - so it is a second thing
 * to maintain. This is what stops it rotting: if `dev --demo` breaks, this suite is red.
 */
/** The React binding's fixture, on its own ports, under the real `dev` command. */
const REACT_PORT = process.env.E2E_REACT_PORT ?? '3220'
const REACT_WT_PORT = process.env.E2E_REACT_WT_PORT ?? '4520'
export const REACT_ORIGIN = `http://localhost:${REACT_PORT}`

/** `examples/react`, built by Vite and served by the real `dev` command, on its own ports. */
const REACT_EXAMPLE_PORT = process.env.E2E_REACT_EXAMPLE_PORT ?? '3230'
const REACT_EXAMPLE_WT_PORT = process.env.E2E_REACT_EXAMPLE_WT_PORT ?? '4530'
export const REACT_EXAMPLE_ORIGIN = `http://localhost:${REACT_EXAMPLE_PORT}`

const DEMO_PORT = process.env.E2E_DEMO_PORT ?? '3210'
const DEMO_WT_PORT = process.env.E2E_DEMO_WT_PORT ?? '4510'
export const DEMO_ORIGIN = `http://localhost:${DEMO_PORT}`

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
  webServer: [
    {
      command:
        `npm run build:e2e-app && node packages/core/dist/cli/main.node.js dev ` +
        `packages/react/e2e-app/server.node.ts ` +
        `--static packages/react/e2e-app/dist --port ${REACT_PORT} --wt-port ${REACT_WT_PORT}`,
      url: `${REACT_ORIGIN}/.well-known/transport-io-dev`,
      reuseExistingServer: false,
      timeout: 90_000,
      stdout: 'pipe',
      stderr: 'pipe',
    },
    {
      command:
        `npm run build -w examples/react && node packages/core/dist/cli/main.node.js dev ` +
        `examples/react/server.node.ts --static examples/react/dist ` +
        `--port ${REACT_EXAMPLE_PORT} --wt-port ${REACT_EXAMPLE_WT_PORT}`,
      url: `${REACT_EXAMPLE_ORIGIN}/.well-known/transport-io-dev`,
      reuseExistingServer: false,
      timeout: 90_000,
      stdout: 'pipe',
      stderr: 'pipe',
    },
    {
      command: `node packages/core/dist/cli/main.node.js dev --demo --port ${DEMO_PORT} --wt-port ${DEMO_WT_PORT}`,
      url: `${DEMO_ORIGIN}/.well-known/transport-io-dev`,
      reuseExistingServer: false,
      timeout: 60_000,
      stdout: 'pipe',
      stderr: 'pipe',
    },
    {
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
  ],
})
