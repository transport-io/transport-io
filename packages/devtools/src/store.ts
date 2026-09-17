/**
 * The panel's state, with no framework and no DOM in it.
 *
 * It subscribes to a client with `observe()`, and everything it does per record is one write
 * into a ring and a few counters, because an observer runs inside the session once per frame.
 * Listeners are told at most once per animation frame, however many records arrived, so the
 * cost of painting is bounded by the display and not by the traffic.
 *
 * The ring holds records, and a record holds no payload (core's D149), so a panel left open
 * for a day holds 1,000 small objects and nothing else.
 */
import type {
  ClientState,
  FrameKind,
  FrameObserver,
  FrameRecord,
  ObserveOptions,
  SessionStats,
} from 'transport-io'

/** What the store needs of a client. `Client` and `FallbackClient` both are one. */
export interface ObservableClient {
  observe(observer: FrameObserver, options?: ObserveOptions): () => void
  subscribe(listener: () => void): () => void
  getSnapshot(): ClientState
  stats(): SessionStats | undefined
}

export type Lane = FrameRecord['lane']

export interface PanelFilter {
  /** Only this event. `null` is every event, and frames that carry none. */
  readonly event: string | null
  readonly lane: Lane | null
}

/** A call stream that has opened and not closed. */
export interface StreamRow {
  readonly session: number
  readonly stream: number
  /** `null` until the request names it, for a stream the peer opened. */
  readonly event: string | null
  /** Which side opened it. */
  readonly dir: 'in' | 'out'
  readonly openedAt: number
  readonly frames: number
  readonly bytes: number
}

export type DropKind = Extract<
  FrameKind,
  'overflow-dropped' | 'stale-dropped' | 'stale-received' | 'direction-dropped'
>

/** How many of one kind of drop one event has had since the panel mounted. */
export interface DropRow {
  readonly kind: DropKind
  readonly event: string | null
  readonly count: number
}

export interface PanelState {
  readonly connection: ClientState
  /** The current session's counters, which restart with each session. `null` with none. */
  readonly stats: SessionStats | null
  readonly paused: boolean
  /** Records that arrived while paused and were not kept. */
  readonly skipped: number
  readonly filter: PanelFilter
  /** Records in the ring, before the filter. */
  readonly held: number
  /** The ring through the filter, oldest first. */
  readonly rows: readonly FrameRecord[]
  /** Bumped when `rows` is not the previous `rows` with more on the end. */
  readonly epoch: number
  readonly streams: readonly StreamRow[]
  readonly drops: readonly DropRow[]
  /** Every event name seen, sorted, for the filter. */
  readonly events: readonly string[]
}

export interface StoreOptions {
  /** How many records the ring holds. 1,000 unless given. */
  readonly capacity?: number
  /** Ask the client for payload previews. Off unless given. */
  readonly preview?: boolean
  /**
   * How a notification is deferred, returning its cancel. Defaults to an animation frame,
   * or 16 ms where there is none. Tests pass their own.
   */
  readonly schedule?: (run: () => void) => () => void
}

export interface PanelStore {
  /** The same reference until something changes, so it suits `useSyncExternalStore`. */
  getSnapshot(): PanelState
  subscribe(listener: () => void): () => void
  /** Stops keeping records, so the rows being read are not overwritten. Counters run on. */
  pause(): void
  resume(): void
  setFilter(filter: Partial<PanelFilter>): void
  /** Empties the ring and the per-event drop counts. */
  clear(): void
  /** The newest `limit` rows as they are filtered now, as text for an issue or a message. */
  copy(limit?: number): string
  /** Unsubscribes from the client and cancels anything scheduled. */
  destroy(): void
}

const DEFAULT_CAPACITY = 1000

const DROPS: ReadonlySet<string> = new Set<DropKind>([
  'overflow-dropped',
  'stale-dropped',
  'stale-received',
  'direction-dropped',
])

function defaultSchedule(run: () => void): () => void {
  if (typeof requestAnimationFrame === 'function') {
    const id = requestAnimationFrame(run)
    return () => cancelAnimationFrame(id)
  }
  const id = setTimeout(run, 16)
  return () => clearTimeout(id)
}

interface MutableStream {
  session: number
  stream: number
  event: string | null
  dir: 'in' | 'out'
  openedAt: number
  frames: number
  bytes: number
}

export function createStore(client: ObservableClient, options: StoreOptions = {}): PanelStore {
  const capacity = Math.max(1, options.capacity ?? DEFAULT_CAPACITY)
  const schedule = options.schedule ?? defaultSchedule

  const ring: (FrameRecord | undefined)[] = new Array(capacity)
  let next = 0
  let held = 0

  const streams = new Map<string, MutableStream>()
  const drops = new Map<string, { kind: DropKind; event: string | null; count: number }>()
  const events = new Set<string>()
  const listeners = new Set<() => void>()

  let paused = false
  let skipped = 0
  let filter: PanelFilter = { event: null, lane: null }
  let epoch = 0
  let session = 0

  let snapshot: PanelState | undefined
  let cancel: (() => void) | undefined
  let destroyed = false

  /** Drops the cached snapshot and tells listeners once, on the next frame. */
  function touch(): void {
    snapshot = undefined
    if (cancel !== undefined || destroyed) return
    cancel = schedule(() => {
      cancel = undefined
      for (const l of listeners) l()
    })
  }

  function onRecord(record: FrameRecord): void {
    // A new session numbers its streams from 1 again, and the old session's never closed
    // as far as this store was told: a disposed session reports nothing.
    if (record.session !== session) {
      session = record.session
      streams.clear()
    }
    if (record.event !== null) events.add(record.event)

    if (record.stream !== null && record.stream > 0) {
      const key = `${record.session}:${record.stream}`
      if (record.kind === 'open') {
        streams.set(key, {
          session: record.session,
          stream: record.stream,
          event: record.event,
          dir: record.dir,
          openedAt: record.at,
          frames: 0,
          bytes: 0,
        })
      } else if (record.kind === 'close') {
        streams.delete(key)
      } else {
        const row = streams.get(key)
        if (row !== undefined) {
          row.frames++
          row.bytes += record.size
          row.event ??= record.event
        }
      }
    }

    if (DROPS.has(record.kind)) {
      const key = `${record.kind}|${record.event ?? ''}`
      const row = drops.get(key)
      if (row === undefined) {
        drops.set(key, { kind: record.kind as DropKind, event: record.event, count: 1 })
      } else row.count++
    }

    if (paused) skipped++
    else {
      ring[next] = record
      next = next + 1 === capacity ? 0 : next + 1
      if (held < capacity) held++
    }
    touch()
  }

  const passes = (r: FrameRecord): boolean =>
    (filter.event === null || r.event === filter.event) &&
    (filter.lane === null || r.lane === filter.lane)

  function rows(): FrameRecord[] {
    const out: FrameRecord[] = []
    const start = held < capacity ? 0 : next
    for (let i = 0; i < held; i++) {
      const r = ring[(start + i) % capacity] as FrameRecord
      if (passes(r)) out.push(r)
    }
    return out
  }

  const stopObserving = client.observe(
    onRecord,
    options.preview === true ? { preview: true } : undefined,
  )
  const stopWatching = client.subscribe(() => {
    if (client.getSnapshot().status !== 'connected') streams.clear()
    touch()
  })

  return {
    getSnapshot(): PanelState {
      snapshot ??= {
        connection: client.getSnapshot(),
        stats: client.stats() ?? null,
        paused,
        skipped,
        filter,
        held,
        rows: rows(),
        epoch,
        streams: [...streams.values()].map((s) => ({ ...s })),
        drops: [...drops.values()]
          .map((d) => ({ ...d }))
          .sort((a, b) => b.count - a.count || a.kind.localeCompare(b.kind)),
        events: [...events].sort(),
      }
      return snapshot
    },

    subscribe(listener: () => void): () => void {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },

    pause(): void {
      if (paused) return
      paused = true
      touch()
    },

    resume(): void {
      if (!paused) return
      paused = false
      skipped = 0
      touch()
    },

    setFilter(change: Partial<PanelFilter>): void {
      filter = { ...filter, ...change }
      epoch++
      touch()
    },

    clear(): void {
      ring.fill(undefined)
      next = 0
      held = 0
      skipped = 0
      drops.clear()
      epoch++
      touch()
    },

    copy(limit?: number): string {
      return formatRows(this.getSnapshot(), limit)
    },

    destroy(): void {
      destroyed = true
      stopObserving()
      stopWatching()
      cancel?.()
      cancel = undefined
      listeners.clear()
      ring.fill(undefined)
      streams.clear()
    },
  }
}

/** `HH:MM:SS.mmm`, UTC, which is what a log line beside it will say too. */
export function clock(at: number): string {
  return new Date(at).toISOString().slice(11, 23)
}

/**
 * The visible rows as tab-separated text, under two lines that say what they were taken
 * from. It is what gets pasted into an issue, so it has to stand on its own there.
 */
export function formatRows(state: PanelState, limit: number = state.rows.length): string {
  const c = state.connection
  const s = state.stats
  const head = [
    `transport-io devtools: ${c.status}, ${c.transport ?? 'no transport'}` +
      (c.fallbackReason === null ? '' : ` (fallback: ${c.fallbackReason})`) +
      `, ${c.sessionId ?? 'no session'}`,
    s === null
      ? 'no session counters'
      : `queueDepth ${s.queueDepth}, overflowDropped ${s.overflowDropped}, staleDropped ` +
        `${s.staleDropped}, staleReceived ${s.staleReceived}, directionDropped ${s.directionDropped}`,
    [
      'time',
      'session',
      'dir',
      'lane',
      'kind',
      'event',
      'stream',
      'size',
      'seq',
      'preview',
    ].join('\t'),
  ]
  // `slice(-0)` is the whole array, so zero is asked about first.
  const newest = limit <= 0 ? [] : state.rows.slice(-limit)
  const body = newest.map((r) =>
    [
      clock(r.at),
      r.session,
      r.dir,
      r.lane,
      r.kind,
      r.event ?? '-',
      r.stream ?? '-',
      r.size,
      r.sequence ?? '-',
      r.preview ?? '',
    ].join('\t'),
  )
  return [...head, ...body].join('\n')
}
