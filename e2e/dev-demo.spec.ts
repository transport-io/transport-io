import { expect, type Page, test } from '@playwright/test'
import { DEMO_ORIGIN } from '../playwright.config.ts'

/**
 * The acceptance test for `npx transport-io dev --demo`, stated the way it was asked for:
 * someone who has never used this library runs one command and sees two tabs talking,
 * without opening openssl or the documentation.
 *
 * Nothing is stubbed. The command minted a real certificate, computed its hash, served it at
 * the well-known endpoint, and started a real QUIC server; the page fetches that hash through
 * `connectDev` and pins it. If any link in that chain breaks, this is red.
 */

const connected = async (page: Page): Promise<void> => {
  await expect(page.locator('#status')).toHaveText('connected', { timeout: 25_000 })
}

test('one command, two tabs, a message crosses', async ({ browser }) => {
  // Separate contexts rather than tabs, so these are two genuinely independent clients.
  const one = await (await browser.newContext()).newPage()
  const two = await (await browser.newContext()).newPage()

  await one.goto(DEMO_ORIGIN)
  await two.goto(DEMO_ORIGIN)
  await connected(one)
  await connected(two)

  await one.fill('#body', 'hello from the first tab')
  await one.press('#body', 'Enter')

  // The reliable lane, so both tabs must have it, including the sender.
  await expect(
    one.locator('#log li').filter({ hasText: 'hello from the first tab' }),
  ).toHaveCount(1)
  await expect(
    two.locator('#log li').filter({ hasText: 'hello from the first tab' }),
  ).toHaveCount(1)
})

test('the certificate hash is served, and it is what the page pins', async ({ page }) => {
  const res = await page.request.get(`${DEMO_ORIGIN}/.well-known/transport-io-dev`)
  expect(res.ok()).toBe(true)
  const manifest = (await res.json()) as { sha256: number[]; url: string }

  // 32 bytes, because it is a SHA-256 over the DER, which is what the browser pins.
  expect(manifest.sha256).toHaveLength(32)
  expect(manifest.url).toMatch(/^https:\/\/127\.0\.0\.1:\d+\/$/)
  // Never cached: renewing the certificate changes this, and a stale copy cannot connect.
  expect(res.headers()['cache-control']).toBe('no-store')
})
