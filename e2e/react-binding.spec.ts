import { expect, test } from '@playwright/test'
import { REACT_ORIGIN } from '../playwright.config.ts'

/**
 * The hooks in a real browser over real QUIC.
 *
 * The unit tests run over the loopback transport, which has hidden two bugs in this project,
 * so the parts that depend on a real session are checked here: StrictMode's double mount
 * against a real reconnect, and a subscription surviving re-renders while frames actually
 * arrive over the network.
 */

test('the provider connects under StrictMode, and events reach a hook', async ({ browser }) => {
  const one = await (await browser.newContext()).newPage()
  const two = await (await browser.newContext()).newPage()

  await one.goto(REACT_ORIGIN)
  await two.goto(REACT_ORIGIN)

  // StrictMode double-mounts, which tears the first session down and builds another. If the
  // provider's refcounting were wrong this would sit on `connecting` forever.
  await expect(one.locator('#status')).toHaveText('connected', { timeout: 25_000 })
  await expect(two.locator('#status')).toHaveText('connected', { timeout: 25_000 })

  await one.evaluate(() => {
    ;(globalThis as { __send?: (b: string) => void }).__send?.('hello from one')
  })

  await expect(two.locator('#log li')).toHaveCount(1, { timeout: 15_000 })
  await expect(two.locator('#log li').first()).toContainText('hello from one')

  // Exactly once at the client, below React. StrictMode's mount-unmount-remount used to
  // leave a superseded session dispatching alongside the live one, so a single broadcast
  // arrived twice; the loopback transport was too fast for the window to open and this is
  // where it was found.
  const counts = await two.evaluate(() => ({
    live: (globalThis as { __live?: number }).__live,
    delivered: (globalThis as { __clientDelivered?: number }).__clientDelivered,
  }))
  expect(counts.live).toBe(1)
  expect(counts.delivered).toBe(1)
})

test('re-rendering does not lose the subscription', async ({ page }) => {
  await page.goto(REACT_ORIGIN)
  await expect(page.locator('#status')).toHaveText('connected', { timeout: 25_000 })

  // Force renders with a fresh inline handler each time. Without the Effect Event this
  // resubscribes on every one of them, and a frame arriving mid-churn is dropped.
  for (let i = 0; i < 25; i++) await page.click('#rerender')
  await expect(page.locator('#renders')).toHaveText('25')

  await page.evaluate(() => {
    ;(globalThis as { __send?: (b: string) => void }).__send?.('after re-renders')
  })

  await expect(page.locator('#log li')).toHaveCount(1, { timeout: 15_000 })
  await expect(page.locator('#log li').first()).toContainText('after re-renders')
})
