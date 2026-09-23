/**
 * The panel in a DOM: what it shows, that it paints only while open, and that a string a
 * peer controls is never markup.
 */
import { afterEach, describe, expect, test } from 'bun:test'
import type { ClientState, FrameObserver, FrameRecord, SessionStats } from 'transport-io'
import { TransportError } from 'transport-io'
import { mountPanel } from './panel.ts'
import type { ObservableClient } from './store.ts'

const connected: ClientState = Object.freeze({
  status: 'connected',
  sessionId: 's-7',
  rooms: [],
  lastError: null,
  refused: null,
  transport: 'webtransport',
  fallbackReason: null,
})

function fake(): {
  client: ObservableClient
  push: (r?: Partial<FrameRecord>) => void
  setState: (next: Partial<ClientState>) => void
} {
  const observers = new Set<FrameObserver>()
  const listeners = new Set<() => void>()
  let snapshot = connected
  const stats: SessionStats = {
    queueDepth: 2,
    overflowDropped: 3,
    staleDropped: 0,
    staleReceived: 0,
    directionDropped: 0,
  }
  let n = 0
  return {
    client: {
      observe: (o) => {
        observers.add(o)
        return () => void observers.delete(o)
      },
      subscribe: (l) => {
        listeners.add(l)
        return () => void listeners.delete(l)
      },
      getSnapshot: () => snapshot,
      stats: () => stats,
    },
    setState: (next) => {
      snapshot = Object.freeze({ ...snapshot, ...next })
      for (const l of listeners) l()
    },
    push: (r = {}) => {
      const record: FrameRecord = {
        at: ++n,
        session: 1,
        kind: 'emit',
        dir: 'in',
        lane: 'reliable',
        event: 'chat',
        stream: 0,
        size: 20,
        sequence: null,
        preview: null,
        ...r,
      }
      for (const o of observers) o(record)
    },
  }
}

/** Frames the test runs by hand, which is also how "paints once per frame" is asserted. */
function frames(): { schedule: (run: () => void) => () => void; tick: () => void } {
  let queued: (() => void)[] = []
  return {
    schedule: (run) => {
      queued.push(run)
      return () => {
        queued = queued.filter((q) => q !== run)
      }
    },
    tick: () => {
      const now = queued
      queued = []
      for (const run of now) run()
    },
  }
}

const unmounts: (() => void)[] = []
afterEach(() => {
  for (const u of unmounts.splice(0, unmounts.length)) u()
})

function mount(options: Parameters<typeof mountPanel>[1] = {}): {
  root: ShadowRoot
  push: (r?: Partial<FrameRecord>) => void
  setState: (next: Partial<ClientState>) => void
  tick: () => void
  unmount: () => void
} {
  const c = fake()
  const f = frames()
  const unmount = mountPanel(c.client, { schedule: f.schedule, ...options })
  unmounts.push(unmount)
  const host = document.querySelector('[data-transport-io-devtools]')
  const root = host?.shadowRoot
  if (root === null || root === undefined) throw new Error('the panel did not mount')
  return { root, push: c.push, setState: c.setState, tick: f.tick, unmount }
}

/** Oldest first, as they read on screen. The list is a reversed column in the document. */
const dataRows = (root: ShadowRoot): HTMLElement[] =>
  [...root.querySelectorAll<HTMLElement>('.rows .r')]
    .filter((row) => !row.classList.contains('session'))
    .reverse()

const button = (root: ShadowRoot, label: string): HTMLButtonElement => {
  const found = [...root.querySelectorAll('button')].find((b) =>
    b.textContent?.startsWith(label),
  )
  if (found === undefined) throw new Error(`no button labelled ${label}`)
  return found
}

describe('closed', () => {
  test('it starts as a launcher, and paints no rows until it is opened', () => {
    const p = mount()
    p.push()
    p.push()
    p.tick()
    expect(p.root.querySelector<HTMLElement>('.panel')?.hidden).toBe(true)
    expect(dataRows(p.root)).toHaveLength(0)

    button(p.root, 'transport-io').click()
    expect(p.root.querySelector<HTMLElement>('.panel')?.hidden).toBe(false)
    // What happened while it was closed is there when it opens.
    expect(dataRows(p.root)).toHaveLength(2)
  })

  test('the launcher says how many were dropped, which is the reason to open it', () => {
    const p = mount()
    p.push({ kind: 'overflow-dropped', event: 'cursor', lane: 'unreliable' })
    p.push({ kind: 'overflow-dropped', event: 'cursor', lane: 'unreliable' })
    p.tick()
    expect(button(p.root, 'transport-io').textContent).toContain('2 dropped')
  })
})

describe('open', () => {
  test('status, transport, session and the counters from stats()', () => {
    const p = mount({ open: true })
    const bar = p.root.querySelector('.bar')?.textContent ?? ''
    expect(bar).toContain('connected on webtransport')
    expect(bar).toContain('s-7')
    expect(bar).toContain('queue 2')
    expect(bar).toContain('overflow 3')
    expect(bar).toContain('direction 0')
  })

  test('a row per record, a divider per session, and drops marked', () => {
    const p = mount({ open: true })
    p.push({ event: 'chat' })
    p.push({ kind: 'stale-received', event: 'cursor', lane: 'unreliable', sequence: 4 })
    p.push({ session: 2, kind: 'handshake', event: null })
    p.tick()

    const rows = dataRows(p.root)
    expect(rows).toHaveLength(3)
    expect(rows[0]?.textContent).toContain('← in')
    expect(rows[1]?.dataset['drop']).toBe('true')
    expect(rows[1]?.textContent).toContain('stale-received')
    expect(p.root.querySelectorAll('.rows .session')).toHaveLength(2)
    expect(p.root.querySelector('.side')?.textContent).toContain('cursor stale-received')
  })

  test('a burst appends its tail, and the list never grows past what it shows', () => {
    const p = mount({ open: true, visibleRows: 10 })
    for (let i = 0; i < 300; i++) p.push()
    p.tick()
    expect(dataRows(p.root).length).toBeLessThanOrEqual(10 + 8)
    expect(dataRows(p.root).at(-1)?.textContent).toContain('00:00:00.300')

    for (let i = 0; i < 5; i++) p.push()
    p.tick()
    expect(dataRows(p.root).at(-1)?.textContent).toContain('00:00:00.305')
    expect(dataRows(p.root).length).toBeLessThanOrEqual(10 + 8)
  })

  test('rows are appended, not rebuilt: a painted row is the same element a frame later', () => {
    const p = mount({ open: true })
    p.push()
    p.tick()
    const first = dataRows(p.root)[0]
    p.push()
    p.tick()
    expect(dataRows(p.root)[0]).toBe(first as HTMLElement)
    expect(dataRows(p.root)).toHaveLength(2)
  })

  test('a preview a peer wrote is text, never markup', () => {
    const p = mount({ open: true })
    p.push({ preview: '<img src=x onerror=alert(1)>', event: '<b>bold</b>' })
    p.tick()
    expect(p.root.querySelector('.rows img')).toBeNull()
    expect(p.root.querySelector('.rows b')).toBeNull()
    expect(dataRows(p.root)[0]?.textContent).toContain('<img src=x onerror=alert(1)>')
  })
})

describe('the brand', () => {
  test('the mark is the two paths of the brand file, filled with the text colour', async () => {
    const asset = await Bun.file(
      new URL('../../../assets/brand/transport-io-mark-currentcolor.svg', import.meta.url),
    ).text()
    const drawn = [...asset.matchAll(/<path d="([^"]+)"/g)].map((m) => m[1] as string)
    expect(drawn).toHaveLength(2)

    const p = mount({ open: true })
    // Once in the launcher and once in the bar, and never redrawn, recoloured or reseated.
    const marks = [...p.root.querySelectorAll('.lockup svg')]
    expect(marks).toHaveLength(2)
    for (const svg of marks) {
      const paths = [...svg.querySelectorAll('path')]
      expect(paths.map((path) => path.getAttribute('d'))).toEqual(drawn)
      expect(paths.every((path) => path.getAttribute('fill') === 'currentColor')).toBe(true)
    }
    expect(p.root.querySelector('.lockup')?.textContent).toBe('transport-io')
  })

  test('no gradient, no shadow, no rounding, and one accent per scheme', () => {
    const p = mount()
    const css = p.root.querySelector('style')?.textContent ?? ''
    expect(css).not.toContain('gradient')
    expect(css).not.toContain('shadow')
    expect([...css.matchAll(/border-radius:\s*([^;]+);/g)].map((m) => m[1])).toEqual(['0'])
    // The palette of assets/brand/USAGE.txt, dark then light, with the two greys and the
    // accent-high the site's stylesheet adds to it, and no other colour anywhere.
    const colours = [...new Set([...css.matchAll(/#[0-9a-f]{6}\b/g)].map((m) => m[0]))]
    expect(colours.sort()).toEqual(
      [
        '#141210',
        '#1d1a16',
        '#e7e2d6',
        '#9c9588',
        '#33302a',
        '#d9692c',
        '#e4e0d6',
        '#f3f1ea',
        '#16130f',
        '#5f5a51',
        '#cfc9bb',
        '#c2551d',
        '#8e3a10',
      ].sort(),
    )
  })

  test('every text colour is 4.5 to 1 against both grounds, in both schemes', () => {
    const p = mount()
    const css = p.root.querySelector('style')?.textContent ?? ''
    const [dark, light] = css.split('@media (prefers-color-scheme: light)')
    const tokens = (block: string): Record<string, string> =>
      Object.fromEntries(
        [...block.matchAll(/--([a-z-]+):\s*(#[0-9a-f]{6})/g)].map((m) => [m[1], m[2]]),
      )
    const channel = (c: number): number =>
      c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4
    const luminance = (hex: string): number => {
      const [r, g, b] = [1, 3, 5].map((i) =>
        channel(Number.parseInt(hex.slice(i, i + 2), 16) / 255),
      )
      return 0.2126 * (r as number) + 0.7152 * (g as number) + 0.0722 * (b as number)
    }
    const contrast = (a: string, b: string): number => {
      const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x)
      return ((hi as number) + 0.05) / ((lo as number) + 0.05)
    }
    // The light block only overrides, so it is read over the dark one.
    const schemes = [
      tokens(dark ?? ''),
      { ...tokens(dark ?? ''), ...tokens((light ?? '').split('}')[0] ?? '') },
    ]
    for (const scheme of schemes) {
      for (const text of ['ink', 'dim', 'accent-text']) {
        for (const ground of ['ground', 'panel']) {
          expect(
            contrast(scheme[text] as string, scheme[ground] as string),
          ).toBeGreaterThanOrEqual(4.5)
        }
      }
      // A mark is not text: the rule beside a drop and the status square need 3 to 1.
      expect(
        contrast(scheme['accent'] as string, scheme['ground'] as string),
      ).toBeGreaterThanOrEqual(3)
    }
  })
})

describe('lastError in the status line', () => {
  const failed = new TransportError(
    'WT_SESSION_CLOSED',
    "TypeError: Cannot read properties of undefined (reading 'digest')",
    'Read `cause`, which is what was thrown.',
    new TypeError("Cannot read properties of undefined (reading 'digest')"),
  )
  const error = (root: ShadowRoot): HTMLButtonElement | null =>
    root.querySelector<HTMLButtonElement>('button.error')
  const why = (root: ShadowRoot): HTMLElement | null => root.querySelector<HTMLElement>('.why')
  /** Each line under the bar as its label and its text. */
  const lines = (root: ShadowRoot): string[][] =>
    [...root.querySelectorAll('.why div')].map((d) =>
      [...d.children].map((c) => c.textContent ?? ''),
    )

  test('nothing beside the status while there is no lastError', () => {
    const p = mount({ open: true })
    p.tick()
    expect(error(p.root)?.hidden).toBe(true)
    expect(why(p.root)?.hidden).toBe(true)
  })

  test('the code always, and the cause and remedy when it is opened', () => {
    const p = mount({ open: true })
    p.setState({ status: 'closed', transport: null, sessionId: null, lastError: failed })
    p.tick()
    expect(error(p.root)?.hidden).toBe(false)
    expect(error(p.root)?.textContent).toBe('WT_SESSION_CLOSED')
    expect(p.root.querySelector('.bar')?.textContent).toContain('closed')
    expect(why(p.root)?.hidden).toBe(true)

    error(p.root)?.click()
    expect(error(p.root)?.getAttribute('aria-expanded')).toBe('true')
    expect(why(p.root)?.hidden).toBe(false)
    expect(lines(p.root)).toEqual([
      ['cause', "TypeError: Cannot read properties of undefined (reading 'digest')"],
      ['remedy', 'Read `cause`, which is what was thrown.'],
    ])

    error(p.root)?.click()
    expect(why(p.root)?.hidden).toBe(true)
  })

  test('with no cause, what the error says in its place', () => {
    const p = mount({ open: true })
    p.setState({
      status: 'closed',
      lastError: new TransportError(
        'WT_UDP_UNREACHABLE',
        'the server answers over HTTPS but the WebTransport handshake failed',
        'Open UDP to the port.',
      ),
    })
    p.tick()
    error(p.root)?.click()
    // The code is on the button, so the sentence is shown without it, and without the remedy.
    expect(lines(p.root)).toEqual([
      ['what', 'the server answers over HTTPS but the WebTransport handshake failed'],
      ['remedy', 'Open UDP to the port.'],
    ])
  })

  test('it follows the snapshot: the next attempt clears it', () => {
    const p = mount({ open: true })
    p.setState({ status: 'closed', lastError: failed })
    p.tick()
    error(p.root)?.click()
    p.setState({ status: 'connecting', lastError: null })
    p.tick()
    expect(error(p.root)?.hidden).toBe(true)
    expect(why(p.root)?.hidden).toBe(true)
  })
})

describe('the side lists', () => {
  test('both say none before anything has happened', () => {
    const p = mount({ open: true })
    const side = p.root.querySelector('.side')?.textContent ?? ''
    expect(side).toContain('Open streamsnone')
    expect(side).toContain('none since the panel mounted')
  })

  test('one frame, then two frames', () => {
    const p = mount({ open: true })
    p.push({ kind: 'open', dir: 'out', stream: 1, event: 'ask', size: 0 })
    p.push({ kind: 'request', dir: 'out', stream: 1, event: 'ask', size: 30 })
    p.tick()
    expect(p.root.querySelector('.side')?.textContent).toContain('#1 ask (out)1 frame, 30 B')
    p.push({ kind: 'response', dir: 'in', stream: 1, event: 'ask', size: 12 })
    p.tick()
    expect(p.root.querySelector('.side')?.textContent).toContain('2 frames, 42 B')
  })
})

describe('pause, filter, copy', () => {
  test('pause freezes the rows and says how many it skipped', () => {
    const p = mount({ open: true })
    p.push()
    p.tick()
    button(p.root, 'Pause').click()
    expect(button(p.root, 'Resume').textContent).toBe('Resume (0 skipped)')
    p.push()
    p.push()
    p.tick()
    expect(dataRows(p.root)).toHaveLength(1)
    expect(button(p.root, 'Resume').textContent).toBe('Resume (2 skipped)')
  })

  test('the event filter lists what was seen, and choosing one rebuilds the list', () => {
    const p = mount({ open: true })
    p.push({ event: 'chat' })
    p.push({ event: 'cursor', lane: 'unreliable', kind: 'datagram' })
    p.tick()

    const select = p.root.querySelector('select') as HTMLSelectElement
    expect([...select.options].map((o) => o.value)).toEqual(['', 'chat', 'cursor'])
    select.value = 'cursor'
    select.dispatchEvent(new Event('change'))
    // A click is painted at once, without waiting for the next paced paint.
    expect(dataRows(p.root)).toHaveLength(1)
    expect(dataRows(p.root)[0]?.textContent).toContain('cursor')
  })

  test('copy puts the visible rows on the clipboard as text', async () => {
    const written: string[] = []
    Object.defineProperty(globalThis.navigator, 'clipboard', {
      configurable: true,
      value: { writeText: async (text: string) => void written.push(text) },
    })
    const p = mount({ open: true, visibleRows: 2 })
    p.push({ event: 'a' })
    p.push({ event: 'b' })
    p.push({ event: 'c' })
    p.tick()

    button(p.root, 'Copy rows').click()
    await Promise.resolve()
    const lines = written[0]?.split('\n') ?? []
    expect(lines[0]).toContain('transport-io devtools: connected, webtransport, s-7')
    // Two header lines, the column names, then the two rows the list shows.
    expect(lines).toHaveLength(5)
    expect(lines[3]).toContain('\tb\t')
    expect(lines[4]).toContain('\tc\t')
  })
})

describe('the page under it', () => {
  test('an open panel reserves its height under the page, and gives it back', () => {
    document.body.style.paddingBottom = '7px'
    const p = mount()
    expect(document.body.style.paddingBottom).toBe('7px')

    button(p.root, 'transport-io').click()
    const panel = p.root.querySelector<HTMLElement>('.panel')
    expect(document.body.style.paddingBottom).toBe(`${panel?.offsetHeight ?? -1}px`)

    button(p.root, 'Close').click()
    expect(document.body.style.paddingBottom).toBe('7px')

    // Unmounting an open panel is a close as well.
    button(p.root, 'transport-io').click()
    p.unmount()
    expect(document.body.style.paddingBottom).toBe('7px')
    document.body.style.paddingBottom = ''
  })
})

describe('unmounting', () => {
  test('removes the host and stops observing', () => {
    const p = mount({ open: true })
    p.unmount()
    expect(document.querySelector('[data-transport-io-devtools]')).toBeNull()
    expect(() => p.push()).not.toThrow()
  })
})
