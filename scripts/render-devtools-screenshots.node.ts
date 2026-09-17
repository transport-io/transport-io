/**
 * Renders the devtools panel's screenshots, in both colour schemes, from real traffic.
 *
 * Two real clients on `examples/chat` over real QUIC, nothing mocked: both pointers move, so
 * datagrams go out and come in; a chat message goes out and comes back; a burst of pointer
 * events arrives inside one task, faster than the datagram queue drains, so the library's own
 * ring overflows and `overflowDropped` is a real number; and a `/say` stream is open while
 * the pictures are taken. A changed panel is one command from a changed screenshot.
 *
 *   npm run build && npm run build:web -w examples/chat
 *   E2E_BROWSER="/path/to/chromium" node scripts/render-devtools-screenshots.node.ts
 *
 * Three pictures per scheme, written to `assets/devtools/`. The package README points at
 * them there, and the site's `prebuild` copies them to where the guide imports them from:
 *
 *   page    the panel open under the application, which answers "what is this"
 *   frames  the frame list close up, at a size where the columns read
 *   drops   the counters and the per-event drops, with real numbers in them
 *
 * The panel's face is IBM Plex Mono when the page has it. The pictures give the page that
 * face, from the `@fontsource` files the site already installs, so they look the same on
 * every machine that renders them. Before anything is captured the rendered text is searched
 * for a filesystem path, and a text colour under 4.5 to 1 against its ground stops the run.
 */
import { type ChildProcess, spawn } from 'node:child_process'
import { mkdirSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { type Browser, chromium, type Page } from '@playwright/test'

const ROOT = resolve(import.meta.dirname, '..')
const PORT = Number(process.env['SHOTS_PORT'] ?? 8207)
const WT_PORT = Number(process.env['SHOTS_WT_PORT'] ?? 4657)
const ORIGIN = `http://localhost:${PORT}`
const OUT = join(ROOT, 'assets/devtools')
const VIEWPORT = { width: 1100, height: 760 }
/** Narrow enough that the whole panel reads at the width of a documentation column. */
const NARROW = { width: 760, height: 700 }
/** One more than the ring holds, five times over: five real drops. */
const BURST = 64 + 5

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
    { cwd: ROOT, stdio: ['ignore', 'pipe', 'inherit'], detached: true },
  )
  return new Promise((ok, fail) => {
    child.once('exit', (code) => fail(new Error(`the dev server exited with ${code}`)))
    child.stdout?.on('data', (chunk: Buffer) => {
      if (chunk.toString().includes('webtransport')) ok(child)
    })
  })
}

function plex(): string {
  const dir = join(ROOT, 'node_modules/@fontsource/ibm-plex-mono/files')
  return [400, 600]
    .map((weight) => {
      const file = readFileSync(join(dir, `ibm-plex-mono-latin-${weight}-normal.woff2`))
      return (
        `@font-face{font-family:'IBM Plex Mono';font-weight:${weight};` +
        `src:url(data:font/woff2;base64,${file.toString('base64')}) format('woff2');}`
      )
    })
    .join('\n')
}

async function connected(page: Page): Promise<void> {
  await page.goto(ORIGIN)
  await page.waitForFunction(
    () => document.getElementById('status')?.textContent === 'connected',
    undefined,
    { timeout: 25_000 },
  )
}

async function sweep(page: Page, from: number, steps: number): Promise<void> {
  const box = await page.locator('#surface').boundingBox()
  if (box === null) throw new Error('the cursor surface is not on the page')
  for (let i = 0; i < steps; i++) {
    const t = (from + i) / 6
    await page.mouse.move(
      box.x + box.width / 2 + (box.width / 3) * Math.cos(t),
      box.y + box.height / 3 + (box.height / 5) * Math.sin(t),
    )
  }
}

async function say(page: Page, text: string): Promise<void> {
  await page.fill('#body', text)
  await page.press('#body', 'Enter')
}

/** Everything the page and the panel render as text, the shadow root included. */
async function renderedText(page: Page): Promise<string> {
  return page.evaluate(() => {
    const host = document.querySelector('[data-transport-io-devtools]')
    return `${document.body.innerText}\n${host?.shadowRoot?.textContent ?? ''}`
  })
}

/** Text colour against the first opaque background behind it, for one of each kind of text. */
async function contrasts(page: Page): Promise<{ what: string; ratio: number }[]> {
  return page.evaluate(() => {
    const root = document.querySelector('[data-transport-io-devtools]')?.shadowRoot
    if (root === null || root === undefined) throw new Error('the panel is not mounted')
    const rgb = (css: string): number[] => (css.match(/[\d.]+/g) ?? []).slice(0, 4).map(Number)
    const luminance = ([r = 0, g = 0, b = 0]: number[]): number => {
      const f = (c: number): number => {
        const s = c / 255
        return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4
      }
      return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b)
    }
    const groundOf = (node: Element): number[] => {
      for (let at: Element | null = node; at !== null; at = at.parentElement) {
        const bg = rgb(getComputedStyle(at).backgroundColor)
        if (bg.length >= 3 && (bg[3] ?? 1) > 0) return bg
      }
      return [255, 255, 255]
    }
    const kinds: [string, string][] = [
      [
        'a reliable row',
        '.rows .r:not(.session):not([data-lane="unreliable"]):not([data-drop])',
      ],
      ['an unreliable row', '.rows .r[data-lane="unreliable"]:not([data-drop])'],
      ['a drop row', '.rows .r[data-drop]'],
      ['the column names', '.head'],
      ['a counter label', '.counter'],
      ['a counter above zero', '.counter[data-hot="true"] b'],
      ['a button', 'button'],
      ['a side label', '.side h2'],
    ]
    return kinds.map(([what, selector]) => {
      const node = root.querySelector(selector)
      if (node === null)
        throw new Error(`nothing matches ${selector}, so ${what} was not checked`)
      const [hi, lo] = [
        luminance(rgb(getComputedStyle(node).color)),
        luminance(groundOf(node)),
      ].sort((a, b) => b - a)
      return { what, ratio: ((hi ?? 0) + 0.05) / ((lo ?? 0) + 0.05) }
    })
  })
}

async function render(browser: Browser, scheme: 'light' | 'dark'): Promise<string[]> {
  const mine = await browser.newContext({
    viewport: VIEWPORT,
    deviceScaleFactor: 2,
    colorScheme: scheme,
  })
  const theirs = await browser.newContext({ viewport: VIEWPORT, colorScheme: scheme })
  const page = await mine.newPage()
  const other = await theirs.newPage()
  await connected(page)
  await connected(other)
  await page.addStyleTag({ content: plex() })
  await page.evaluate(() =>
    Promise.all([
      document.fonts.load("12px 'IBM Plex Mono'"),
      document.fonts.load("600 12px 'IBM Plex Mono'"),
    ]),
  )

  const panel = page.locator('[data-transport-io-devtools]')
  await panel.locator('.launcher').click()

  // Datagrams in, then datagrams out.
  await sweep(other, 0, 14)
  await sweep(page, 0, 10)
  // The reliable lane: out, and back from the room.
  await say(page, 'the panel sees this go out and come back')
  // More pointer events inside one task than the ring holds. The queue is the library's and
  // the session is real, so the five that do not fit are five real `overflowDropped`.
  await page.evaluate((count) => {
    const surface = document.getElementById('surface')
    if (surface === null) throw new Error('the cursor surface is not on the page')
    const box = surface.getBoundingClientRect()
    for (let i = 0; i < count; i++) {
      surface.dispatchEvent(
        new PointerEvent('pointermove', {
          clientX: box.left + 40 + i * 4,
          clientY: box.top + 60 + i,
          bubbles: true,
        }),
      )
    }
  }, BURST)
  await say(page, 'and this one after the burst')
  await panel.locator('.counter[data-hot="true"]').first().waitFor({ timeout: 10_000 })
  await panel.locator('.rows .r').filter({ hasText: 'after the burst' }).nth(1).waitFor()

  // Nothing is captured until the page has been searched for a path and read for contrast.
  const inspect = async (): Promise<void> => {
    const text = await renderedText(page)
    const path = /(\/Users\/|\/home\/|[A-Za-z]:\\|file:\/\/)/.exec(text)
    if (path !== null || text.includes(ROOT)) {
      throw new Error(`a filesystem path is rendered on the page, near "${path?.[0]}"`)
    }
    for (const { what, ratio } of await contrasts(page)) {
      console.log(`  ${scheme}: ${what.padEnd(22)} ${ratio.toFixed(2)} to 1`)
      if (ratio < 4.5)
        throw new Error(`${what} is ${ratio.toFixed(2)} to 1 in ${scheme}, under 4.5`)
    }
  }

  // The drops picture, while the drops are still the newest rows: the whole panel, in a
  // window narrow enough that nothing has to be cropped through the middle of a word.
  const written: string[] = []
  const keep = async (
    name: string,
    take: (file: string) => Promise<unknown>,
  ): Promise<void> => {
    const file = `${name}-${scheme}.png`
    await page.evaluate(() => window.scrollTo(0, 0))
    await take(join(OUT, file))
    written.push(file)
  }
  await inspect()
  await page.setViewportSize(NARROW)
  await keep('drops', (path) => panel.locator('.panel').screenshot({ path, type: 'png' }))
  await page.setViewportSize(VIEWPORT)

  // A stream that is still open while the pictures are taken: a word every 80 ms.
  const words = Array.from({ length: 70 }, (_, i) => `word${i + 1}`).join(' ')
  await say(page, `/say ${words}`)
  await panel.locator('.side .row').filter({ hasText: 'say' }).waitFor({ timeout: 10_000 })
  await panel.locator('.rows .r').filter({ hasText: 'response' }).nth(3).waitFor()

  await inspect()

  const frames = await panel.locator('.frames').boundingBox()
  if (frames === null)
    throw new Error('the frame list has no box, so there is nothing to crop to')
  await keep('page', (path) => page.screenshot({ path, type: 'png' }))
  await keep('frames', (path) =>
    page.screenshot({
      path,
      type: 'png',
      clip: {
        x: frames.x,
        y: frames.y,
        width: Math.min(frames.width, 800),
        height: frames.height,
      },
    }),
  )
  await mine.close()
  await theirs.close()
  return written
}

mkdirSync(OUT, { recursive: true })
const server = await startServer()
const executablePath = process.env['E2E_BROWSER']
const browser = await chromium.launch({
  headless: true,
  ...(executablePath === undefined ? {} : { executablePath }),
})
try {
  for (const scheme of ['light', 'dark'] as const) {
    for (const file of await render(browser, scheme)) {
      console.log(`wrote assets/devtools/${file}`)
    }
  }
} finally {
  await browser.close()
  if (server.pid !== undefined) process.kill(-server.pid, 'SIGTERM')
}
process.exit(0)
