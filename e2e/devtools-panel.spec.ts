import { expect, type Page, test } from '@playwright/test'
import { REACT_ORIGIN } from '../playwright.config.ts'

/**
 * The devtools panel in a real browser, over real QUIC, mounted by the chat example.
 *
 * The unit tests drive the panel with records they wrote. This is the other half: that a
 * real session produces those records, a real shadow root paints them, and the clipboard
 * gets the rows, which is the part somebody pastes into an issue.
 */

const connected = async (page: Page): Promise<void> => {
  await expect(page.locator('#status')).toHaveText('connected', { timeout: 20_000 })
  await expect(page.locator('#rooms')).toHaveText('lobby')
}

// Playwright's CSS locators reach into an open shadow root.
const panel = (page: Page) => page.locator('[data-transport-io-devtools]')
const rows = (page: Page) => panel(page).locator('.rows .r:not(.session)')

test('the panel shows a call, an emit and a datagram as they cross the wire', async ({
  browser,
}) => {
  const context = await browser.newContext()
  await context.grantPermissions(['clipboard-read', 'clipboard-write'])
  const page = await context.newPage()
  await page.goto('/')
  await connected(page)

  // Closed until somebody opens it, and nothing painted before that.
  await expect(panel(page).locator('.panel')).toBeHidden()
  await panel(page).locator('.launcher').click()
  await expect(panel(page).locator('.panel')).toBeVisible()
  await expect(panel(page).locator('.bar').first()).toContainText('connected on webtransport')

  // It mounted before connect(), so the session's first frames are there: the handshake
  // both ways, the room it was joined to, and the setName call from open to close.
  await expect(rows(page).filter({ hasText: 'handshake' })).toHaveCount(2)
  await expect(rows(page).filter({ hasText: 'join' })).toHaveCount(1)
  const call = rows(page).filter({ hasText: 'setName' })
  await expect(call.filter({ hasText: 'open' })).toHaveCount(1)
  await expect(call.filter({ hasText: 'request' })).toHaveCount(1)
  await expect(call.filter({ hasText: 'response' })).toHaveCount(1)
  await expect(call.filter({ hasText: 'close' })).toHaveCount(1)

  // The reliable lane: out, and back in from the room.
  await page.fill('#body', 'seen by the panel')
  await page.press('#body', 'Enter')
  await expect(rows(page).filter({ hasText: 'seen by the panel' })).toHaveCount(2)

  // The unreliable lane: a datagram with a sequence number and no stream.
  const box = await page.locator('#surface').boundingBox()
  expect(box).not.toBeNull()
  if (box === null) return
  await page.mouse.move(box.x + 40, box.y + 40)
  await page.mouse.move(box.x + 80, box.y + 60)
  const datagram = rows(page).filter({ hasText: 'datagram' }).filter({ hasText: 'cursor' })
  await expect(datagram.first()).toBeVisible()
  await expect(datagram.first()).toContainText('unreliable')

  // The filter narrows the list to one event.
  await panel(page).locator('select').first().selectOption('cursor')
  await expect(rows(page).filter({ hasText: 'handshake' })).toHaveCount(0)
  await expect(rows(page).filter({ hasText: 'cursor' }).first()).toBeVisible()

  // Copy rows: what it was taken from, the column names, then the rows.
  await panel(page).getByRole('button', { name: 'Copy rows' }).click()
  await expect(panel(page).getByRole('button', { name: 'Copied' })).toBeVisible()
  const copied = await page.evaluate(() => navigator.clipboard.readText())
  const lines = copied.split('\n')
  expect(lines[0]).toContain('transport-io devtools: connected, webtransport')
  expect(lines[1]).toContain('overflowDropped')
  expect(lines[2]).toBe('time\tsession\tdir\tlane\tkind\tevent\tstream\tsize\tseq\tpreview')
  expect(lines.length).toBeGreaterThan(3)
  for (const line of lines.slice(3)) expect(line).toContain('\tcursor\t')

  await context.close()
})

test('on the agents page the panel lists both open streams, and a stopped one closes', async ({
  page,
}) => {
  await page.goto('/agents.html')
  await expect(page.locator('#status')).toHaveText('connected', { timeout: 20_000 })
  await expect(page.locator('#open')).toHaveText('2', { timeout: 15_000 })
  await panel(page).locator('.launcher').click()

  // Two `stream()` calls on one session: two open rows, and two entries in the side column,
  // each on its own stream. The kind and event columns are adjacent, so the pattern cannot
  // match a word the answer happens to contain.
  const streams = panel(page).locator('.side .row').filter({ hasText: 'generate' })
  await expect(streams).toHaveCount(2)
  await expect(rows(page).filter({ hasText: /\bopen\s+generate\b/ })).toHaveCount(2)
  const ids = await streams.allInnerTexts()
  expect(ids[0]?.split(' ')[0]).not.toBe(ids[1]?.split(' ')[0])

  // The words come back one response frame each, with the word in the preview.
  await expect(
    rows(page)
      .filter({ hasText: /\bresponse\s+generate\b/ })
      .nth(3),
  ).toBeVisible({
    timeout: 15_000,
  })

  // Stopping one is a close row for that stream and one entry fewer, and the other is
  // still listed.
  await page.click('#a-stop')
  await expect(page.locator('#a-state')).toHaveText('stopped', { timeout: 5_000 })
  await expect(rows(page).filter({ hasText: /\bclose\s+generate\b/ })).toHaveCount(1)
  await expect(streams).toHaveCount(1)
})

test('the React mount leaves one open panel under StrictMode, and it sees the session', async ({
  page,
}) => {
  await page.goto(REACT_ORIGIN)
  await expect(page.locator('#status')).toHaveText('connected', { timeout: 25_000 })

  // StrictMode mounts, unmounts and mounts again. One host means the first unmount removed
  // its panel, and the one that is left is the one observing.
  await expect(panel(page)).toHaveCount(1)
  await expect(panel(page).locator('.panel')).toBeVisible()
  await expect(panel(page).locator('.bar').first()).toContainText('connected on webtransport')

  await page.evaluate(() => {
    ;(globalThis as { __send?: (b: string) => void }).__send?.('seen under react')
  })
  await expect(
    rows(page).filter({ hasText: 'emit' }).filter({ hasText: 'chat' }).first(),
  ).toBeVisible()
})
