import { expect, type Page, test } from '@playwright/test'
import { AGENTS, paceOf } from '../examples/chat/agents.ts'

/**
 * The claim the landing page is built on, and the one thing here that is hard to believe
 * from prose: two streams running at once, one of them stopped, and the other not noticing.
 *
 * The demo page is the fixture, so the demo cannot rot. If stopping one stream ever starts
 * costing the other a single token, this goes red before anyone records anything.
 *
 * What makes this a test rather than a screenshot is the bound. "The other one kept going"
 * is satisfied by one straggling token arriving a second later, which is exactly what a
 * stalled stream looks like from the outside. So the assertion is a rate: the running panel
 * must gain a specific number of tokens inside a specific window.
 */

/** What the server will actually pace an agent at, from the module the server itself reads. */
function tokensPerSecond(name: string): number {
  const agent = AGENTS[name]
  if (agent === undefined) throw new Error(`unknown agent '${name}'`)
  const totalMs = agent.tokens.reduce((sum, _, i) => sum + paceOf(agent, i), 0)
  return (agent.tokens.length / totalMs) * 1000
}

const SLOWEST = Math.min(tokensPerSecond('agent-a'), tokensPerSecond('agent-b'))
const WINDOW_MS = 1_500

/**
 * Half of what the slower agent delivers in that window. Computed rather than written down,
 * because a pace this asserts against is a pace someone will change: at a literal, slowing
 * the demo for readability turns this green test red and the fix looks like lowering a bar.
 *
 * Half leaves room for a CI machine running at half speed, which is not the defect this is
 * looking for. A stalled stream delivers none, and the distance from half to zero is the
 * only distance that matters here.
 */
const MUST_ARRIVE = Math.floor((SLOWEST * WINDOW_MS) / 1000 / 2)

const tokensIn = async (page: Page, id: 'a' | 'b'): Promise<number> =>
  Number((await page.locator(`#${id}-tokens`).textContent()) ?? '0')

const streaming = async (page: Page): Promise<void> => {
  await expect(page.locator('#a-state')).toHaveText('streaming', { timeout: 15_000 })
  await expect(page.locator('#b-state')).toHaveText('streaming', { timeout: 15_000 })
  // Two `stream()` calls, so two bidirectional streams on one session.
  await expect(page.locator('#open')).toHaveText('2')
  // Far enough in that a stop lands mid-generation rather than before the first frame.
  await expect.poll(() => tokensIn(page, 'a'), { timeout: 15_000 }).toBeGreaterThan(10)
  await expect.poll(() => tokensIn(page, 'b'), { timeout: 15_000 }).toBeGreaterThan(10)
}

async function stopOneAndProveTheOther(
  page: Page,
  stopped: 'a' | 'b',
  running: 'a' | 'b',
): Promise<void> {
  await page.click(`#${stopped}-stop`)

  await expect(page.locator(`#${stopped}-state`)).toHaveText('stopped', { timeout: 5_000 })
  // One stream left open on the session, and it is the other one.
  await expect(page.locator('#open')).toHaveText('1')
  await expect(page.locator(`#${running}-state`)).toHaveText('streaming')

  const frozen = await tokensIn(page, stopped)
  const before = await tokensIn(page, running)

  await expect
    .poll(() => tokensIn(page, running), { timeout: WINDOW_MS })
    .toBeGreaterThanOrEqual(before + MUST_ARRIVE)

  // The stopped one really is stopped, not merely slower. Read after the window above, so
  // anything still in flight when the reset went out has had time to land.
  expect(await tokensIn(page, stopped)).toBe(frozen)

  // The page's own arithmetic, which is what a viewer reads.
  await expect(page.locator(`#${running}-since`)).toContainText(
    `since agent-${stopped} stopped`,
  )
}

test('stopping one stream does not stall the other, in either direction', async ({ page }) => {
  await page.goto('/agents.html')
  await expect(page.locator('#status')).toHaveText('connected', { timeout: 20_000 })

  await streaming(page)
  await stopOneAndProveTheOther(page, 'a', 'b')

  // The same thing the other way round, because "stop" being wired to one panel and a
  // no-op on the other would pass every assertion above.
  await page.click('#restart')
  await streaming(page)
  await stopOneAndProveTheOther(page, 'b', 'a')
})

test('a stream nobody stops runs to completion', async ({ page }) => {
  await page.goto('/agents.html')
  await expect(page.locator('#status')).toHaveText('connected', { timeout: 20_000 })

  // The end of the script, so a generator that stops early or a tokenizer that drops the
  // tail is a failure here rather than something noticed while recording.
  await expect(page.locator('#a-state')).toHaveText('done', { timeout: 30_000 })
  await expect(page.locator('#a-out')).toContainText('takes nothing else down with it')
  await expect(page.locator('#open')).toHaveText('1')
})
