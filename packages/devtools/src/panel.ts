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
  reasonOf,
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
 * A row's height, and the space above and below the list. The space is a margin and not a
 * padding: a scroller's padding does not clip, so the row above the first whole one showed
 * through it as a few pixels of text.
 */
const ROW_HEIGHT = 18
const ROWS_MARGIN = 3

/**
 * A row is one element holding one line of text, its columns padded to these widths in a
 * monospace face. Nine cells a row made 2,000 elements of a full list, and the browser's
 * layout, paint and layer passes are paid per element per frame of the page underneath, which
 * the panel does not control. One element a row is a tenth of that. An event name longer
 * than its column is cut here and whole in what Copy rows produces.
 */
const WIDTHS = [12, 5, 10, 17, 18, 6, 7, 7] as const

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

/**
 * The brand's own rules, from `assets/brand/USAGE.txt` and the site's stylesheet: ink and bone,
 * one accent, IBM Plex Mono for labels, hairline rules, square corners, and no gradient, no
 * shadow and no rounding anywhere. So nothing here is a colour that arrived with a template:
 * a row is ink, a datagram is dim because there are many of them and they matter least, and
 * the accent is kept for the one thing the panel exists to show, which is a drop.
 *
 * Text has to be read, so every text colour is held to 4.5 to 1 against what it sits on, by a
 * test. On the light ground the brand's dim is 4.38 and its accent 3.46, so there the dim is
 * the site's next grey down and accent text is the site's `accent-high`; the accent itself
 * stays for the marks that are not text, the rule beside a drop and the status square.
 *
 * The face is Plex when the page has it and the system's monospace when it does not. A panel
 * that fetched a font would be a panel that made a request from inside somebody's application.
 */
const STYLE = `
:host {
  all: initial;
  --ground: #141210; --panel: #1d1a16; --ink: #e7e2d6; --dim: #9c9588; --line: #33302a;
  --accent: #d9692c; --accent-text: #d9692c;
}
@media (prefers-color-scheme: light) {
  :host {
    --ground: #e4e0d6; --panel: #f3f1ea; --ink: #16130f; --dim: #5f5a51; --line: #cfc9bb;
    --accent: #c2551d; --accent-text: #8e3a10;
  }
}
* { box-sizing: border-box; border-radius: 0; }
.launcher, .panel {
  position: fixed; z-index: 2147483000; color: var(--ink); background: var(--ground);
  font: 12px/1.5 'IBM Plex Mono', ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  font-variant-numeric: tabular-nums; -webkit-font-smoothing: antialiased;
}
.launcher {
  right: 12px; bottom: 12px; border: 1px solid var(--ink); padding: 7px 10px; cursor: pointer;
  display: flex; gap: 9px; align-items: center;
}
.launcher:hover { background: var(--panel); }
.lockup { display: inline-flex; gap: 8px; align-items: center; font-weight: 600;
  letter-spacing: -0.01em; }
.lockup svg { width: 16px; height: 16px; display: block; }
.panel {
  left: 0; right: 0; bottom: 0; height: 42vh; min-height: 220px; display: flex;
  flex-direction: column; border-top: 1px solid var(--ink); contain: layout paint style;
}
[hidden] { display: none !important; }
.bar {
  display: flex; flex-wrap: wrap; gap: 6px 16px; align-items: center; padding: 7px 12px;
  border-bottom: 1px solid var(--line); background: var(--panel);
}
.tools { background: var(--ground); gap: 6px 8px; }
.dot { width: 8px; height: 8px; background: var(--dim); display: inline-block; }
.dot[data-status="connected"] { background: var(--ink); }
.dot[data-status="closed"] { background: var(--accent); }
.status { display: inline-flex; gap: 8px; align-items: center; }
.muted { color: var(--dim); }
.counter b { color: var(--ink); font-weight: 600; }
.counter[data-hot="true"] b { color: var(--accent-text); }
.drops { color: var(--accent-text); }
button.error { color: var(--accent-text); border-color: var(--accent); }
.why { padding: 5px 12px; border-bottom: 1px solid var(--line); background: var(--panel);
  max-height: 9em; overflow: auto; }
.why div { display: flex; gap: 12px; }
.why .muted { flex: none; width: 6ch; }
.why span:last-child { white-space: pre-wrap; overflow-wrap: anywhere; }
.spacer { flex: 1; }
button, select {
  font: inherit; color: var(--ink); background: transparent; border: 1px solid var(--line);
  padding: 2px 10px; cursor: pointer; appearance: none; -webkit-appearance: none;
}
select { padding-right: 24px; }
/* The caret is a character, so nothing here has to be drawn. */
.select { position: relative; display: inline-flex; }
.select::after { content: '▾'; position: absolute; right: 8px; top: 2px; color: var(--dim);
  pointer-events: none; }
button:hover, select:hover { border-color: var(--ink); }
button:focus-visible, select:focus-visible { outline: 1px solid var(--accent); outline-offset: 1px; }
button[aria-pressed="true"] { border-color: var(--accent); color: var(--accent-text); }
.body { flex: 1; min-height: 0; display: flex; }
.frames { flex: 1; min-width: 0; display: flex; flex-direction: column; }
.side { width: 300px; border-left: 1px solid var(--line); overflow: auto; padding: 4px 12px 10px; }
.side h2 { font: inherit; color: var(--dim); margin: 8px 0 4px; padding-bottom: 3px;
  border-bottom: 1px solid var(--line); }
.r { padding: 0 12px 0 10px; border-left: 2px solid transparent; white-space: pre;
  height: ${ROW_HEIGHT}px; flex: none; overflow: hidden; }
.head { color: var(--dim); border-bottom: 1px solid var(--ink); height: 22px; line-height: 21px; }
/* Newest first in the document and last on screen: a reversed column stays pinned to its end
   while rows arrive, and stays where it is once somebody scrolls up to read, with no script.
   The first child is the row on screen last, and its auto margin takes the free space, so a
   list shorter than the panel starts under the header and not at the bottom of a gap. */
.rows { flex: none; height: 0; overflow: auto; display: flex; flex-direction: column-reverse;
  contain: strict; margin: ${ROWS_MARGIN}px 0; scrollbar-color: var(--line) transparent; }
.rows > :first-child { margin-bottom: auto; }
.r[data-lane="unreliable"] { color: var(--dim); }
.r[data-drop="true"] { color: var(--accent-text); border-left-color: var(--accent); }
.r.session { color: var(--dim); border-top: 1px solid var(--line); margin-top: 3px; }
/* The last child is the row on screen first. Under the header's own rule it needs none. */
.rows > .session:last-child { border-top-color: transparent; margin-top: 0; }
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

const SVG = 'http://www.w3.org/2000/svg'

/**
 * The mark and the wordmark, as `assets/brand/transport-io-mark-currentcolor.svg` and the
 * lockup give them: the two paths unaltered, filled with the text colour, which is bone on
 * the dark ground and ink on the light one, and the name in the semibold of the same face.
 */
function lockup(): HTMLElement {
  const svg = document.createElementNS(SVG, 'svg')
  svg.setAttribute('viewBox', '0 0 64 64')
  svg.setAttribute('aria-hidden', 'true')
  for (const d of ['M4 8 H42 V23 L27 32 L42 41 V56 H4 Z', 'M45 46 L62 40 L62 57 H45 Z']) {
    const path = document.createElementNS(SVG, 'path')
    path.setAttribute('d', d)
    path.setAttribute('fill', 'currentColor')
    svg.append(path)
  }
  const wrap = el('span', 'lockup')
  wrap.append(svg, el('span', undefined, 'transport-io'))
  return wrap
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
  const launcherDrops = el('span', 'drops')
  launcher.append(lockup(), launcherDot, launcherDrops)

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
  const state = el('span', 'status')
  state.append(dot, status)
  // `lastError`'s code, always, and a button that opens its cause and remedy under the bar. A
  // status of `closed` with no reason beside it is how a failed connect reads when only the
  // status is shown (D156).
  const error = el('button', 'error')
  error.setAttribute('aria-expanded', 'false')
  bar.append(lockup(), state, error, session)
  const why = el('div', 'why')
  const causeLabel = el('span', 'muted')
  const causeText = el('span')
  const remedyText = el('span')
  const causeLine = el('div')
  causeLine.append(causeLabel, causeText)
  const remedyLine = el('div')
  remedyLine.append(el('span', 'muted', 'remedy'), remedyText)
  why.append(causeLine, remedyLine)
  let expanded = false
  for (const [key, label] of counterNames) {
    const wrap = el('span', 'counter muted', `${label} `)
    const value = el('b', undefined, '0')
    wrap.append(value)
    counters.set(key, { wrap, value })
    bar.append(wrap)
  }

  const tools = el('div', 'bar tools')
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
  const boxed = (select: HTMLSelectElement): HTMLElement => {
    const box = el('span', 'select')
    box.append(select)
    return box
  }
  tools.append(
    pause,
    clear,
    copy,
    boxed(eventFilter),
    boxed(laneFilter),
    held,
    el('span', 'spacer'),
    close,
  )

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
  panel.append(bar, why, tools, body)
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
        r.dir === 'out' ? '→ out' : '← in',
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
    if (streamsKey !== streamsPainted || streamsList.childElementCount === 0) {
      streamsPainted = streamsKey
      streamsList.replaceChildren(
        ...(state.streams.length === 0
          ? [el('div', 'muted', 'none')]
          : state.streams.map((s) => {
              const row = el('div', 'row')
              row.append(
                el('span', undefined, `#${s.stream} ${s.event ?? '?'} (${s.dir})`),
                el(
                  'span',
                  'muted',
                  `${s.frames} ${s.frames === 1 ? 'frame' : 'frames'}, ${s.bytes} B`,
                ),
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
    const err = c.lastError
    error.hidden = err === null
    why.hidden = err === null || !expanded
    if (err !== null) {
      say(error, err.code)
      const [label, text] = reasonOf(err)
      say(causeLabel, label)
      say(causeText, text)
      say(remedyText, err.remedy)
    }
    for (const [key] of counterNames) {
      const counter = counters.get(key)
      if (counter === undefined) continue
      const n = state.stats === null ? 0 : state.stats[key]
      say(counter.value, String(n))
      mark(counter.wrap, 'hot', String(key !== 'queueDepth' && n > 0))
    }

    say(pause, state.paused ? `Resume (${state.skipped} skipped)` : 'Pause')
    const pressed = String(state.paused)
    if (pause.getAttribute('aria-pressed') !== pressed)
      pause.setAttribute('aria-pressed', pressed)
    say(held, `${state.rows.length} of ${state.held} held`)
    paintEvents(state)
    paintRows(state)
    paintSide(state)
  }

  // The panel is fixed along the bottom of the window, so while it is open the page gets
  // that much padding under it, and a control the panel would have covered can be scrolled
  // to instead. The padding the page had is put back when the panel closes.
  let pagePadding: string | null = null
  const reserve = (): void => {
    const body = host.ownerDocument.body
    if (open) {
      if (pagePadding === null) pagePadding = body.style.paddingBottom
      const height = `${panel.offsetHeight}px`
      if (body.style.paddingBottom !== height) body.style.paddingBottom = height
    } else if (pagePadding !== null) {
      body.style.paddingBottom = pagePadding
      pagePadding = null
    }
  }

  // ---------------------------------------------------------------- wiring
  // What somebody clicked is painted at once: the pacing is for traffic, not for a button.
  const setOpen = (next: boolean): void => {
    open = next
    // Rows that arrived while closed were never painted, so the list starts over.
    paintedEpoch = -1
    paint()
    reserve()
  }
  launcher.addEventListener('click', () => setOpen(true))
  error.addEventListener('click', () => {
    expanded = !expanded
    error.setAttribute('aria-expanded', String(expanded))
    paint()
  })
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

  // The list shows whole rows only. Its height is whatever the panel leaves it, which is
  // rarely a multiple of a row, and the row cut by the top edge showed as a few pixels of
  // text under the column names. An observer is told after layout, so reading a height here
  // forces nothing, and it runs when the panel opens or the window changes, never per frame.
  // The same resize moves the panel's edge, so the page's padding follows it here too.
  const fit =
    typeof ResizeObserver === 'function'
      ? new ResizeObserver(() => {
          const room = frames.clientHeight - head.offsetHeight - 2 * ROWS_MARGIN
          const height = `${Math.max(1, Math.floor(room / ROW_HEIGHT)) * ROW_HEIGHT}px`
          if (rowsEl.style.height !== height) rowsEl.style.height = height
          reserve()
        })
      : undefined
  fit?.observe(frames)

  const unsubscribe = store.subscribe(paint)
  ;(options.target ?? document.body).append(host)
  paint()
  reserve()

  return () => {
    fit?.disconnect()
    clearTimeout(relabel)
    unsubscribe()
    store.destroy()
    open = false
    reserve()
    host.remove()
  }
}
