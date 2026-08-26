import { expect, type Page, test } from '@playwright/test'

/**
 * The canonical end-to-end test: two browser contexts join one room, one message is sent
 * on each lane, and both contexts receive it.
 *
 * Everything under it is theory until this passes — real Chromium, real QUIC over UDP, a
 * real pinned certificate, and the example app as the fixture.
 */

const connected = async (page: Page): Promise<void> => {
  await expect(page.locator('#status')).toHaveText('connected', { timeout: 20_000 })
  await expect(page.locator('#rooms')).toHaveText('lobby')
}

const lines = (page: Page) => page.locator('#log .line')

test('two clients in one room exchange a message on each lane', async ({ browser }) => {
  // Separate contexts, not tabs: two genuinely independent clients.
  const alice = await (await browser.newContext()).newPage()
  const bob = await (await browser.newContext()).newPage()

  await alice.goto('/')
  await bob.goto('/')
  await connected(alice)
  await connected(bob)

  // Each client is told its name by a call() — request and response on their own
  // bidirectional stream, with no correlation identifier anywhere.
  await expect(lines(alice).filter({ hasText: 'you are' })).toHaveCount(1)
  await expect(lines(bob).filter({ hasText: 'you are' })).toHaveCount(1)

  // ---------- stream lane: reliable, so both must receive it ----------
  await alice.fill('#body', 'reliable hello')
  await alice.press('#body', 'Enter')

  await expect(lines(alice).filter({ hasText: 'reliable hello' })).toHaveCount(1)
  await expect(lines(bob).filter({ hasText: 'reliable hello' })).toHaveCount(1)

  // ---------- datagram lane: bob must see alice's cursor ----------
  const surface = alice.locator('#surface')
  const box = await surface.boundingBox()
  expect(box).not.toBeNull()
  if (box === null) return

  const STEP_X = 12
  const STEPS = 12

  const cursor = bob.locator('#surface .cursor')

  // One move first, so the dot exists and its starting position can be read. Reading the
  // position rather than computing it keeps this independent of how the page maps a
  // pointer event onto the surface.
  await alice.mouse.move(box.x + 60, box.y + 50)
  await expect(cursor).toHaveCount(1, { timeout: 10_000 })
  const positionOf = async (): Promise<readonly [number, number]> => {
    const style = await cursor.getAttribute('style')
    const m = /translate\((-?\d+(?:\.\d+)?)px, (-?\d+(?:\.\d+)?)px\)/.exec(style ?? '')
    expect(m).not.toBeNull()
    return [Number(m?.[1]), Number(m?.[2])]
  }
  const [firstX] = await positionOf()

  // Several more moves, because the lane is allowed to drop any individual one.
  for (let i = 1; i < STEPS; i++) {
    await alice.mouse.move(box.x + 60 + i * STEP_X, box.y + 50 + i * 6)
    await alice.waitForTimeout(30)
  }

  // Last-write-wins: the dot ends at the FINAL position, not the first.
  //
  // The old assertion was `toMatch(/translate\(\d+px, \d+px\)/)`, which every one of the
  // twelve positions satisfies — including the first. A sign error in `SequenceGate.accept`
  // that froze the cursor after one datagram passed it went straight through. Movement is
  // the only thing that distinguishes last-write-wins from first-write-wins, so movement is
  // what is asserted, and by the exact distance travelled rather than merely "more".
  await expect
    .poll(async () => (await positionOf())[0], { timeout: 5_000 })
    .toBe(firstX + (STEPS - 1) * STEP_X)

  // Alice does not receive her own cursor — the server excludes the sender.
  await expect(alice.locator('#surface .cursor')).toHaveCount(0)

  await alice.context().close()
  await bob.context().close()
})

test('a dropped datagram never becomes a dropped chat message', async ({ browser }) => {
  const page = await (await browser.newContext()).newPage()
  await page.goto('/')
  await connected(page)

  // Flood the datagram lane hard enough to force our own ring to drop, then confirm the
  // stream lane is untouched by it. The two lanes make different promises and this is
  // where that stops being a claim.
  await page.evaluate(() => {
    const surface = document.getElementById('surface')
    if (surface === null) return
    const r = surface.getBoundingClientRect()
    for (let i = 0; i < 400; i++) {
      surface.dispatchEvent(
        new PointerEvent('pointermove', {
          bubbles: true,
          clientX: r.left + (i % 200),
          clientY: r.top + (i % 100),
        }),
      )
    }
  })

  for (const body of ['one', 'two', 'three']) {
    await page.fill('#body', body)
    await page.press('#body', 'Enter')
  }

  for (const body of ['one', 'two', 'three']) {
    await expect(lines(page).filter({ hasText: `: ${body}` })).toHaveCount(1, {
      timeout: 10_000,
    })
  }

  // Our counters, not the network's — and a real number, not the static label. 400 moves
  // in one turn is far past the 64-frame ring, so drop-oldest must have fired.
  await expect
    .poll(
      async () => {
        const text = (await page.locator('#drops').textContent()) ?? ''
        return Number(/overflow (\d+)/.exec(text)?.[1] ?? 0)
      },
      { timeout: 10_000 },
    )
    .toBeGreaterThan(0)
  await page.context().close()
})
