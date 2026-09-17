import { expect, type Page, test } from '@playwright/test'
import { REACT_ORIGIN } from '../playwright.config.ts'

/**
 * Signing in again without a reload, under `TransportProvider` and StrictMode, in a real
 * browser. The provider holds the one `connect()`, so the page calls the pair from
 * `useConnection()`: `disconnect()` takes the hold to zero, `connect()` back to one, and the
 * `query` function sends the token as it is by then. The application that asked for the
 * example reloads instead and had never run this path, so it is run here before it is
 * written down.
 */

type Snapshot = { status: string; refused: { reason: string } | null }
const snapshot = (page: Page): Promise<Snapshot> =>
  page.evaluate(() =>
    (
      globalThis as unknown as { __client: { getSnapshot: () => Snapshot } }
    ).__client.getSnapshot(),
  )
const asked = (page: Page): Promise<string[]> =>
  page.evaluate(() => (globalThis as unknown as { __asked: string[] }).__asked)

test('refused at the door: the pair from useConnection signs in again, and the hold is back at one', async ({
  page,
}) => {
  const errors: string[] = []
  page.on('pageerror', (e) => errors.push(String(e)))
  await page.goto(`${REACT_ORIGIN}/signin.html`)

  // Refused, and nothing is retrying: the button is the only way on.
  await expect(page.locator('#signin')).toHaveText('sign in again (expired)', {
    timeout: 25_000,
  })
  const before = await asked(page)
  await page.waitForTimeout(1_500)
  expect(await asked(page)).toEqual(before)

  await page.click('#signin')
  await expect(page.locator('#status')).toHaveText('connected', { timeout: 25_000 })
  expect((await asked(page)).at(-1)).toBe('good')
  expect((await snapshot(page)).refused).toBeNull()

  // The hold landed back at one: the provider's own disconnect, on unmount, closes the
  // client. At two it would stay connected with nobody holding it.
  await page.click('#unmount')
  await expect(page.locator('#gone')).toHaveText('unmounted')
  await expect
    .poll(async () => (await snapshot(page)).status, { timeout: 10_000 })
    .toBe('closed')
  expect(errors).toEqual([])
})

test('refused on a reconnect: a token that expired under an open page, and the same pair', async ({
  page,
}) => {
  await page.goto(`${REACT_ORIGIN}/signin.html`)
  await expect(page.locator('#signin')).toBeVisible({ timeout: 25_000 })
  await page.click('#signin')
  await expect(page.locator('#status')).toHaveText('connected', { timeout: 25_000 })

  // Every token issued so far stops being valid and every session drops. The reconnect
  // sends `good` again and is refused, which is final, so the button comes back.
  await page.evaluate(() => {
    const client = (
      globalThis as unknown as {
        __client: { call: (e: string, p: unknown) => Promise<unknown> }
      }
    ).__client
    void client.call('save', { text: '__expire' }).catch(() => undefined)
  })
  await expect(page.locator('#signin')).toHaveText('sign in again (expired)', {
    timeout: 25_000,
  })

  // The page's sign-in would fetch a fresh token here. The button sets `good`, which no
  // longer passes, so set the one that does after it and sign in a second time.
  const attempts = (await asked(page)).length
  await page.click('#signin')
  await expect
    .poll(
      async () =>
        (await asked(page)).length > attempts && (await snapshot(page)).refused !== null,
      { timeout: 25_000 },
    )
    .toBe(true)
  await page.evaluate(() => {
    ;(globalThis as unknown as { __setToken: (t: string) => void }).__setToken('fresh')
  })
  await page.evaluate(() => {
    const client = (
      globalThis as unknown as {
        __client: { disconnect: () => void; connect: () => Promise<void> }
      }
    ).__client
    client.disconnect()
    void client.connect().catch(() => undefined)
  })
  await expect(page.locator('#status')).toHaveText('connected', { timeout: 25_000 })
  expect((await asked(page)).at(-1)).toBe('fresh')

  await page.click('#unmount')
  await expect
    .poll(async () => (await snapshot(page)).status, { timeout: 10_000 })
    .toBe('closed')
})
