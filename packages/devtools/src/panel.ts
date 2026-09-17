/**
 * The panel: plain DOM in a shadow root, with no framework under it.
 *
 * It reads the store and paints when the store says something changed, at most ten times a
 * second. A paint appends the new rows, trims the old ones, and writes a label only when its
 * text changed; the list is rebuilt only when the filter changes or the ring is cleared.
 * Nothing is painted while the panel is closed, and the store keeps observing, so opening it
 * shows what already happened.
 *
 * That shape is a measurement, not a preference. The first version painted every animation
 * frame into a `<table>`: closed it cost nothing, and open it cost 170 to 190 ms of main-thread
 * time a second on `examples/chat`, the same at 60 records a second as at 500, so the cost was
 * the painting and not the traffic. This one costs between 1 and 34. See D150, and
 * `scripts/bench-devtools-paint.node.ts`.
 *
 * Every string a peer controls, an event name or a payload preview, reaches the page through
 * `textContent`. None of it is ever parsed as markup.
 */
import type { FrameRecord } from 'transport-io'
import {
  clock,
  createStore,
  type ObservableClient,
  type PanelState,
  type PanelStore,
  type StoreOptions,
} from './store.ts'

export interface PanelOptions extends StoreOptions {
  /** Where the panel's host element is appended. `document.body` unless given. */
  readonly target?: Element
  /** Start open. Closed unless given: a launcher in the corner, and no painting. */
  readonly open?: boolean
  /** How many rows the list shows, newest last. 200 unless given. */
  readonly visibleRows?: number
}

const DEFAULT_VISIBLE_ROWS = 200

/** The least time between two paints. Ten a second reads as live, and costs a sixth. */
const PAINT_INTERVAL_MS = 100

/**
 * A row is one element holding one line of text, its columns padded to these widths in a
 * monospace face. Nine cells a row made 2,000 elements of a full list, and the browser's
 * layout, paint and layer passes are paid per element per frame of the page underneath, which
 * the panel does not control. One element a row is a tenth of that. An event name longer
 * than its column is cut here and whole in what Copy rows produces.
 */
const WIDTHS = [12, 3, 10, 17, 18, 6, 7, 7] as const

function cell(text: string, width: number, right = false): string {
  const cut = text.length > width ? `${text.slice(0, width - 1)}…` : text
  return right ? cut.padStart(width) : cut.padEnd(width)
}

function line(
  cells: readonly [string, string, string, string, string, string, string, string, string],
): string {
  return [
    cell(cells[0], WIDTHS[0]),
    cell(cells[1], WIDTHS[1]),
    cell(cells[2], WIDTHS[2]),
    cell(cells[3], WIDTHS[3]),
    cell(cells[4], WIDTHS[4]),
    cell(cells[5], WIDTHS[5], true),
    cell(cells[6], WIDTHS[6], true),
    cell(cells[7], WIDTHS[7], true),
    cells[8],
  ].join('  ')
}

const STYLE = `
:host { all: initial; }
* { box-sizing: border-box; }
.launcher, .panel {
  position: fixed; z-index: 2147483000; font: 12px/1.45 ui-monospace, SFMono-Regular, Menlo,
  Consolas, monospace; color: #d7dae0; background: #16181d;
}
.launcher {
  right: 12px; bottom: 12px; border: 1px solid #2f343d; border-radius: 6px; padding: 6px 10px;
  cursor: pointer; display: flex; gap: 8px; align-items: center;
}
.launcher:hover { background: #1d2027; }
.panel {
  left: 0; right: 0; bottom: 0; height: 42vh; min-height: 220px; display: flex;
  flex-direction: column; border-top: 1px solid #2f343d; contain: layout paint style;
}
[hidden] { display: none !important; }
.bar {
  display: flex; flex-wrap: wrap; gap: 6px 14px; align-items: center; padding: 6px 10px;
  border-bottom: 1px solid #2f343d; background: #1b1e24;
}
.dot { width: 8px; height: 8px; border-radius: 50%; background: #6b7280; display: inline-block; }
.dot[data-status="connected"] { background: #3fb950; }
.dot[data-status="connecting"], .dot[data-status="closing"] { background: #d29922; }
.dot[data-status="closed"] { background: #f85149; }
.muted { color: #8b93a1; }
.counter b { color: #d7dae0; font-weight: 600; }
.counter[data-hot="true"] b { color: #f0883e; }
.spacer { flex: 1; }
button, select {
  font: inherit; color: inherit; background: #242830; border: 1px solid #2f343d;
  border-radius: 4px; padding: 2px 8px; cursor: pointer;
}
button:hover, select:hover { background: #2c313a; }
.body { flex: 1; min-height: 0; display: flex; }
.frames { flex: 1; min-width: 0; display: flex; flex-direction: column; }
.side { width: 300px; border-left: 1px solid #2f343d; overflow: auto; padding: 6px 10px; }
.side h2 { font: inherit; color: #8b93a1; margin: 8px 0 4px; text-transform: uppercase;
  letter-spacing: 0.04em; font-size: 11px; }
.r { padding: 0 10px; white-space: pre; height: 18px; flex: none; overflow: hidden; }
.head { color: #8b93a1; background: #1b1e24; }
/* Newest first in the document and last on screen: a reversed column stays pinned to its end
   while rows arrive, and stays where it is once somebody scrolls up to read, with no script. */
.rows { flex: 1; min-height: 0; overflow: auto; display: flex; flex-direction: column-reverse;
  contain: strict; }
.r[data-dir="out"] { color: #79b8ff; }
.r[data-lane="unreliable"] { color: #d2a8ff; }
.r[data-lane="unreliable"][data-dir="out"] { color: #b392f0; }
.r[data-drop="true"] { background: #3a1f16; color: #f0883e; }
.r.session { color: #8b93a1; border-top: 1px solid #2f343d; }
.row { display: flex; justify-content: space-between; gap: 8px; }
`

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className?: string,
  text?: string,
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag)
  if (className !== undefined) node.className = className
  if (text !== undefined) node.textContent = text
  return node
}

/** A write is a style and layout invalidation, so a label that did not change is left alone. */
function say(node: HTMLElement, text: string): void {
  if (node.textContent !== text) node.textContent = text
}

/** The same, for the data attribute a style rule reads. */
function mark(node: HTMLElement, key: string, value: string): void {
  if (node.dataset[key] !== value) node.dataset[key] = value
}

const isDrop = (r: FrameRecord): boolean =>
  r.kind.endsWith('-dropped') || r.kind === 'stale-received'

/** At most one notification per interval, on the frame after it, so a paint is never torn. */
function paced(run: () => void): () => void {
  let frame: number | undefined
  const timer = setTimeout(() => {
    if (typeof requestAnimationFrame === 'function') frame = requestAnimationFrame(run)
    else run()
  }, PAINT_INTERVAL_MS)
  return () => {
    clearTimeout(timer)
    if (frame !== undefined) cancelAnimationFrame(frame)
  }
}

/**
 * Mounts the panel and returns the unmount. It reads no environment: whether a build gets a
 * panel is the caller's decision, made where the caller can see it.
 */
export function mountPanel(client: ObservableClient, options: PanelOptions = {}): () => void {
  const store: PanelStore = createStore(client, { schedule: paced, ...options })
  const visible = Math.max(1, options.visibleRows ?? DEFAULT_VISIBLE_ROWS)
  let open = options.open === true

  const host = el('div')
  host.setAttribute('data-transport-io-devtools', '')
  const root = host.attachShadow({ mode: 'open' })
  root.append(el('style', undefined, STYLE))

  // ---------------------------------------------------------------- launcher
  const launcher = el('button', 'launcher')
  const launcherDot = el('span', 'dot')
  const launcherDrops = el('span', 'muted')
  launcher.append(launcherDot, el('span', undefined, 'transport-io'), launcherDrops)

  // ---------------------------------------------------------------- panel
  const panel = el('section', 'panel')
  const bar = el('div', 'bar')
  const dot = el('span', 'dot')
  const status = el('span')
  const session = el('span', 'muted')
  const counterNames = [
    ['queueDepth', 'queue'],
    ['overflowDropped', 'overflow'],
    ['staleDropped', 'stale'],
    ['staleReceived', 'stale rx'],
    ['directionDropped', 'direction'],
  ] as const
  const counters = new Map<string, { wrap: HTMLElement; value: HTMLElement }>()
  bar.append(dot, status, session)
  for (const [key, label] of counterNames) {
    const wrap = el('span', 'counter muted', `${label} `)
    const value = el('b', undefined, '0')
    wrap.append(value)
    counters.set(key, { wrap, value })
    bar.append(wrap)
  }

  const tools = el('div', 'bar')
  const pause = el('button', undefined, 'Pause')
  const clear = el('button', undefined, 'Clear')
  const copy = el('button', undefined, 'Copy rows')
  const eventFilter = el('select')
  const laneFilter = el('select')
  for (const [value, label] of [
    ['', 'every lane'],
    ['reliable', 'reliable'],
    ['unreliable', 'unreliable'],
  ] as const) {
    const option = el('option', undefined, label)
    option.value = value
    laneFilter.append(option)
  }
  const held = el('span', 'muted')
  const close = el('button', undefined, 'Close')
  tools.append(pause, clear, copy, eventFilter, laneFilter, held, el('span', 'spacer'), close)

  const body = el('div', 'body')
  const frames = el('div', 'frames')
  const head = el(
    'div',
    'r head',
    line(['time UTC', 'dir', 'lane', 'kind', 'event', 'stream', 'size', 'seq', 'preview']),
  )
  const rowsEl = el('div', 'rows')
  frames.append(head, rowsEl)

  const side = el('aside', 'side')
  const streamsList = el('div')
  const dropsList = el('div')
  side.append(
    el('h2', undefined, 'Open streams'),
    streamsList,
    el('h2', undefined, 'Drops by event'),
    dropsList,
  )

  body.append(frames, side)
  panel.append(bar, tools, body)
  root.append(launcher, panel)

  // ---------------------------------------------------------------- painting
  let paintedEpoch = -1
  let lastPainted: FrameRecord | undefined
  let lastSession = 0
  let eventsPainted = ''
  let streamsPainted = ''
  let dropsPainted = ''

  function rowFor(r: FrameRecord): HTMLElement {
    const row = el(
      'div',
      'r',
      line([
        clock(r.at),
        r.dir,
        r.lane,
        r.kind,
        r.event ?? '',
        r.stream === null ? '' : String(r.stream),
        String(r.size),
        r.sequence === null ? '' : String(r.sequence),
        r.preview ?? '',
      ]),
    )
    row.dataset['dir'] = r.dir
    row.dataset['lane'] = r.lane
    if (isDrop(r)) row.dataset['drop'] = 'true'
    return row
  }

  /** The list is a reversed column, so the newest row goes first in the document. */
  function add(r: FrameRecord): void {
    if (r.session !== lastSession) {
      lastSession = r.session
      rowsEl.prepend(el('div', 'r session', `session ${r.session}`))
    }
    rowsEl.prepend(rowFor(r))
  }

  function paintRows(state: PanelState): void {
    const rows = state.rows
    // Where the rows already painted end in the new list. Records only ever arrive at the
    // end, so everything after that point is new. Not found means the ring has moved past
    // it, or the list was rebuilt, and then the tail is painted afresh.
    let from = -1
    if (state.epoch === paintedEpoch && lastPainted !== undefined) {
      from = rows.lastIndexOf(lastPainted)
    }
    if (from === -1) {
      rowsEl.replaceChildren()
      lastSession = 0
      from = Math.max(0, rows.length - visible) - 1
    }
    // A burst larger than the list shows only its tail: the rest would be trimmed at once.
    const first = Math.max(from + 1, rows.length - visible)
    for (let i = first; i < rows.length; i++) add(rows[i] as FrameRecord)
    while (rowsEl.childElementCount > visible + 8) rowsEl.lastElementChild?.remove()

    paintedEpoch = state.epoch
    lastPainted = rows.at(-1)
  }

  function paintEvents(state: PanelState): void {
    const key = state.events.join('\n')
    if (key === eventsPainted) return
    eventsPainted = key
    const every = el('option', undefined, 'every event')
    every.value = ''
    const options = state.events.map((name) => {
      const option = el('option', undefined, name)
      option.value = name
      return option
    })
    eventFilter.replaceChildren(every, ...options)
    eventFilter.value = state.filter.event ?? ''
  }

  function paintSide(state: PanelState): void {
    const streamsKey = state.streams
      .map((s) => `${s.session}:${s.stream}:${s.event}:${s.frames}:${s.bytes}`)
      .join('|')
    if (streamsKey !== streamsPainted) {
      streamsPainted = streamsKey
      streamsList.replaceChildren(
        ...(state.streams.length === 0
          ? [el('div', 'muted', 'none')]
          : state.streams.map((s) => {
              const row = el('div', 'row')
              row.append(
                el('span', undefined, `#${s.stream} ${s.event ?? '?'} (${s.dir})`),
                el('span', 'muted', `${s.frames} frames, ${s.bytes} B`),
              )
              return row
            })),
      )
    }
    const dropsKey = state.drops.map((d) => `${d.kind}:${d.event}:${d.count}`).join('|')
    if (dropsKey !== dropsPainted || dropsList.childElementCount === 0) {
      dropsPainted = dropsKey
      dropsList.replaceChildren(
        ...(state.drops.length === 0
          ? [el('div', 'muted', 'none since the panel mounted')]
          : state.drops.map((d) => {
              const row = el('div', 'row')
              row.append(
                el('span', undefined, `${d.event ?? '?'} ${d.kind}`),
                el('span', undefined, String(d.count)),
              )
              return row
            })),
      )
    }
  }

  function paint(): void {
    const state = store.getSnapshot()
    const c = state.connection
    const drops = state.drops.reduce((n, d) => n + d.count, 0)

    launcher.hidden = open
    panel.hidden = !open
    mark(launcherDot, 'status', c.status)
    say(launcherDrops, drops === 0 ? '' : `${drops} dropped`)
    if (!open) return

    mark(dot, 'status', c.status)
    say(
      status,
      c.transport === null
        ? c.status
        : `${c.status} on ${c.transport}` +
            (c.fallbackReason === null ? '' : ` (fallback: ${c.fallbackReason})`),
    )
    say(session, c.sessionId ?? '')
    for (const [key] of counterNames) {
      const counter = counters.get(key)
      if (counter === undefined) continue
      const n = state.stats === null ? 0 : state.stats[key]
      say(counter.value, String(n))
      mark(counter.wrap, 'hot', String(key !== 'queueDepth' && n > 0))
    }

    say(pause, state.paused ? `Resume (${state.skipped} skipped)` : 'Pause')
    say(held, `${state.rows.length} of ${state.held} held`)
    paintEvents(state)
    paintRows(state)
    paintSide(state)
  }

  // ---------------------------------------------------------------- wiring
  // What somebody clicked is painted at once: the pacing is for traffic, not for a button.
  const setOpen = (next: boolean): void => {
    open = next
    // Rows that arrived while closed were never painted, so the list starts over.
    paintedEpoch = -1
    paint()
  }
  launcher.addEventListener('click', () => setOpen(true))
  close.addEventListener('click', () => setOpen(false))
  pause.addEventListener('click', () => {
    if (store.getSnapshot().paused) store.resume()
    else store.pause()
    paint()
  })
  clear.addEventListener('click', () => {
    store.clear()
    paint()
  })
  eventFilter.addEventListener('change', () => {
    store.setFilter({ event: eventFilter.value === '' ? null : eventFilter.value })
    paint()
  })
  laneFilter.addEventListener('change', () => {
    const lane = laneFilter.value
    store.setFilter({ lane: lane === 'reliable' || lane === 'unreliable' ? lane : null })
    paint()
  })
  let relabel: ReturnType<typeof setTimeout> | undefined
  copy.addEventListener('click', () => {
    const text = store.copy(visible)
    const done = (label: string): void => {
      copy.textContent = label
      clearTimeout(relabel)
      relabel = setTimeout(() => {
        copy.textContent = 'Copy rows'
      }, 1200)
    }
    const clipboard = globalThis.navigator?.clipboard
    if (clipboard === undefined) {
      done('No clipboard here')
      return
    }
    clipboard.writeText(text).then(
      () => done('Copied'),
      () => done('Copy was refused'),
    )
  })

  const unsubscribe = store.subscribe(paint)
  ;(options.target ?? document.body).append(host)
  paint()

  return () => {
    clearTimeout(relabel)
    unsubscribe()
    store.destroy()
    host.remove()
  }
}
