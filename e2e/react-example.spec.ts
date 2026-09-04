import { expect, type Page, test } from '@playwright/test'
import { REACT_EXAMPLE_ORIGIN } from '../playwright.config.ts'

/**
 * `examples/react` in a real browser over real QUIC: the provider connects, `useCall` names
 * each window, `useEvent` delivers a line to both, `useStream` grows a word at a time and
 * stops on the button, and a cursor crosses the unreliable lane.
 */

const ready = async (page: Page): Promise<void> => {
  await page.goto(REACT_EXAMPLE_ORIGIN)
  await expect(page.locator('#status')).toHaveText('connected', { timeout: 25_000 })
  await expect(page.locator('#me')).toHaveText(/^guest-/, { timeout: 10_000 })
}

const lines = (page: Page) => page.locator('#log .line')

test('two windows: a chat line reaches both, and a cursor crosses', async ({ browser }) => {
  const alice = await (await browser.newContext()).newPage()
  const bob = await (await browser.newContext()).newPage()
  await ready(alice)
  await ready(bob)

  await alice.fill('#body', 'hello from react')
  await alice.press('#body', 'Enter')
  await expect(lines(alice).filter({ hasText: 'hello from react' })).toHaveCount(1, {
    timeout: 10_000,
  })
  await expect(lines(bob).filter({ hasText: 'hello from react' })).toHaveCount(1, {
    timeout: 10_000,
  })

  const box = await alice.locator('#surface').boundingBox()
  expect(box).not.toBeNull()
  if (box === null) return

  // Several moves, because the lane is allowed to drop any individual one.
  for (let i = 0; i < 12; i++) {
    await alice.mouse.move(box.x + 40 + i * 10, box.y + 40 + i * 5)
    await alice.waitForTimeout(25)
  }
  await expect(bob.locator('#surface .cursor')).toHaveCount(1, { timeout: 10_000 })
  await expect(alice.locator('#surface .cursor')).toHaveCount(0)

  await alice.context().close()
  await bob.context().close()
})

test('useStream grows a word at a time, and the stop button ends it', async ({ page }) => {
  await ready(page)
  const stream = page.locator('#stream')

  await page.fill('#body', '/say one two three')
  await page.press('#body', 'Enter')
  await expect(stream).toContainText('one', { timeout: 5_000 })
  await expect(stream).toContainText('three', { timeout: 10_000 })
  await expect(stream).toHaveAttribute('data-state', 'done', { timeout: 5_000 })

  // Forty words at 80 ms each is over three seconds; the stop lands early in it.
  const words = Array.from({ length: 40 }, (_, i) => `w${i}`).join(' ')
  await page.fill('#body', `/say ${words}`)
  await page.press('#body', 'Enter')
  await expect(stream).toContainText('w2', { timeout: 5_000 })
  await page.click('#stop')
  await expect(stream).toHaveAttribute('data-state', 'done', { timeout: 5_000 })

  // Nothing arrives after the stop, and the tail of the script never did.
  const text = await stream.textContent()
  await page.waitForTimeout(600)
  expect(await stream.textContent()).toBe(text)
  expect(text).not.toContain('w39')
})
