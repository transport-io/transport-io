/**
 * What the devtools panel costs the page it is mounted in, measured on `examples/chat`.
 *
 * The panel's paint is bounded by design: one paint per animation frame, new rows appended,
 * a capped table. A bound by design is a claim, and this is the measurement. Two real clients
 * in one room; both pointers are driven at a fixed rate, so the measured page emits that many
 * `cursor` datagrams a second and receives as many. Main-thread time comes from the browser's
 * own counters over a fixed window, and frame pacing from `requestAnimationFrame` in the page.
 *
 * Three modes. `absent` is the page with the `mountPanel` call taken out of its bundle, which
 * is the floor. `closed` is the panel mounted and shut: it observes and paints nothing. `open`
 * is the panel open and painting.
 *
 *   npm run build && npm run build:web -w examples/chat
 *   E2E_BROWSER="/path/to/chromium" node scripts/bench-devtools-paint.node.ts
 *
 * `E2E_BROWSER` is optional where Playwright has its own Chromium installed. See D150.
 */
import { type ChildProcess, spawn } from 'node:child_process'
import { type Browser, type CDPSession, chromium, type Page } from '@playwright/test'

const PORT = Number(process.env['BENCH_PORT'] ?? 8197)
const WT_PORT = Number(process.env['BENCH_WT_PORT'] ?? 4647)
const ORIGIN = `http://localhost:${PORT}`
const WINDOW_MS = 10_000
const RATES = (process.env['BENCH_RATES'] ?? '60,120,500').split(',').map(Number)
const MODES = ['absent', 'closed', 'open'] as const
type Mode = (typeof MODES)[number]

function startServer(): Promise<ChildProcess> {
  const child = spawn(
    'node',
    [
      'packages/core/dist/cli/main.node.js',
      'dev',
      'examples/chat/server.node.ts',
      '--static',
      'examples/chat/web',
      '--port',
      String(PORT),
      '--wt-port',
      String(WT_PORT),
    ],
    // Its own process group, because the dev command runs the entry as a child of its own and
    // stopping only the parent leaves that child holding the UDP port.
    { stdio: ['ignore', 'pipe', 'inherit'], detached: true },
  )
  return new Promise((resolve, reject) => {
    child.once('exit', (code) => reject(new Error(`the dev server exited with ${code}`)))
    child.stdout?.on('data', (chunk: Buffer) => {
      if (chunk.toString().includes('webtransport')) resolve(child)
    })
  })
}

async function open(browser: Browser, mode: Mode): Promise<{ page: Page; cdp: CDPSession }> {
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 } })
  const page = await context.newPage()
  if (mode === 'absent') {
    // The same bundle with the one call removed, so nothing else about the page differs.
    await page.route('**/dist/main.js', async (route) => {
      const response = await route.fetch()
      const source = await response.text()
      const call = 'mountPanel(client, { preview: true });'
      if (source.split(call).length !== 2) throw new Error('expected one mountPanel call')
      await route.fulfill({ response, body: source.replace(call, '') })
    })
  }
  await page.goto(ORIGIN)
  await page.waitForFunction(
    () => document.getElementById('status')?.textContent === 'connected',
    undefined,
    { timeout: 25_000 },
  )
  if (mode === 'open') await page.locator('[data-transport-io-devtools] .launcher').click()
  const cdp = await context.newCDPSession(page)
  await cdp.send('Performance.enable')
  return { page, cdp }
}

/** Drives a pointer round the cursor surface at `rate` events a second until stopped. */
function drive(cdp: CDPSession, rate: number): () => number {
  let sent = 0
  const started = Date.now()
  const timer = setInterval(() => {
    // Catch up to where the clock says the count should be, so timer jitter does not slow it.
    const due = Math.floor(((Date.now() - started) / 1000) * rate)
    while (sent < due) {
      const t = sent / 40
      void cdp
        .send('Input.dispatchMouseEvent', {
          type: 'mouseMoved',
          x: 960 + 250 * Math.cos(t),
          y: 300 + 100 * Math.sin(t),
        })
        .catch(() => undefined)
      sent++
    }
  }, 4)
  return () => {
    clearInterval(timer)
    return sent
  }
}

async function metrics(cdp: CDPSession): Promise<Record<string, number>> {
  const { metrics: list } = await cdp.send('Performance.getMetrics')
  return Object.fromEntries(list.map((m) => [m.name, m.value]))
}

interface Sample {
  readonly taskMs: number
  readonly scriptMs: number
  readonly layoutMs: number
  readonly styleMs: number
  readonly frames: number
  readonly slowFrames: number
  readonly worstFrameMs: number
  readonly moves: number
  readonly received: number
}

async function measure(browser: Browser, mode: Mode, rate: number): Promise<Sample> {
  const measured = await open(browser, mode)
  const other = await open(browser, 'absent')

  await measured.page.evaluate(() => {
    const w = window as unknown as { bench: { deltas: number[]; moves: number } }
    w.bench = { deltas: [], moves: 0 }
    document.getElementById('surface')?.addEventListener('pointermove', () => w.bench.moves++)
    let last = performance.now()
    const tick = (now: number): void => {
      w.bench.deltas.push(now - last)
      last = now
      requestAnimationFrame(tick)
    }
    requestAnimationFrame(tick)
  })

  const stopA = drive(measured.cdp, rate)
  const stopB = drive(other.cdp, rate)
  await measured.page.waitForTimeout(1_500) // warm-up, then the window starts clean
  await measured.page.evaluate(() => {
    const w = window as unknown as { bench: { deltas: number[]; moves: number } }
    w.bench.deltas.length = 0
    w.bench.moves = 0
  })
  const receivedBefore = Number(await measured.page.locator('#rx-cursor').textContent())
  const before = await metrics(measured.cdp)
  await measured.page.waitForTimeout(WINDOW_MS)
  const after = await metrics(measured.cdp)
  const receivedAfter = Number(await measured.page.locator('#rx-cursor').textContent())
  stopA()
  stopB()

  const bench = await measured.page.evaluate(
    () => (window as unknown as { bench: { deltas: number[]; moves: number } }).bench,
  )
  await measured.page.context().close()
  await other.page.context().close()

  const seconds = WINDOW_MS / 1000
  const per = (name: string): number =>
    (((after[name] ?? 0) - (before[name] ?? 0)) * 1000) / seconds
  return {
    taskMs: per('TaskDuration'),
    scriptMs: per('ScriptDuration'),
    layoutMs: per('LayoutDuration'),
    styleMs: per('RecalcStyleDuration'),
    frames: bench.deltas.length / seconds,
    slowFrames: bench.deltas.filter((d) => d > 25).length,
    worstFrameMs: Math.max(0, ...bench.deltas),
    moves: bench.moves / seconds,
    received: (receivedAfter - receivedBefore) / seconds,
  }
}

const median = (values: number[]): number =>
  [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)] ?? 0

const server = await startServer()
const executablePath = process.env['E2E_BROWSER']
const browser = await chromium.launch({
  headless: true,
  ...(executablePath === undefined ? {} : { executablePath }),
})
console.log(`browser ${browser.version()}, ${WINDOW_MS / 1000} s windows, median of 3`)
console.log(
  'rate  mode    out/s  in/s  task ms/s  script  layout  style  frames/s  slow  worst ms',
)
try {
  for (const rate of RATES) {
    for (const mode of MODES) {
      const runs: Sample[] = []
      for (let i = 0; i < 3; i++) runs.push(await measure(browser, mode, rate))
      const m = (pick: (s: Sample) => number): number => median(runs.map(pick))
      console.log(
        [
          String(rate).padEnd(5),
          mode.padEnd(7),
          m((s) => s.moves)
            .toFixed(0)
            .padStart(5),
          m((s) => s.received)
            .toFixed(0)
            .padStart(5),
          m((s) => s.taskMs)
            .toFixed(1)
            .padStart(10),
          m((s) => s.scriptMs)
            .toFixed(1)
            .padStart(7),
          m((s) => s.layoutMs)
            .toFixed(1)
            .padStart(7),
          m((s) => s.styleMs)
            .toFixed(1)
            .padStart(6),
          m((s) => s.frames)
            .toFixed(1)
            .padStart(9),
          m((s) => s.slowFrames)
            .toFixed(0)
            .padStart(5),
          m((s) => s.worstFrameMs)
            .toFixed(1)
            .padStart(9),
        ].join(' '),
      )
    }
  }
} finally {
  await browser.close()
  if (server.pid !== undefined) process.kill(-server.pid, 'SIGTERM')
}
process.exit(0)
