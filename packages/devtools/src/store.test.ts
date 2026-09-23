/**
 * The store against a real client over the loopback transport, and against a hand-driven
 * one where the test needs to say exactly which records arrive.
 */
import { describe, expect, test } from 'bun:test'
import {
  Client,
  type ClientState,
  createServer,
  defineContract,
  type FrameObserver,
  type FrameRecord,
  type MapOf,
  reliable,
  rpc,
  type SessionStats,
  streaming,
  TransportError,
  unreliable,
} from 'transport-io'
import { loopbackPair } from 'transport-io/testing'
import { createStore, formatRows, type ObservableClient } from './store.ts'

const contract = defineContract({
  chat: reliable<{ body: string }>(),
  cursor: unreliable<{ x: number }>(),
  save: rpc<{ text: string }, { n: number }>(),
  ask: streaming<{ n: number }, number>(),
})
interface AppMap extends MapOf<typeof contract> {}

const settle = async (n = 12): Promise<void> => {
  for (let i = 0; i < n; i++) await new Promise((r) => setTimeout(r, 1))
}

/** A scheduler the test runs by hand, so "at most once per frame" is something to assert. */
function frames(): {
  schedule: (run: () => void) => () => void
  tick: () => void
  pending: () => number
} {
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
    pending: () => queued.length,
  }
}

const connected: ClientState = Object.freeze({
  status: 'connected',
  sessionId: 's-1',
  rooms: [],
  lastError: null,
  refused: null,
  transport: 'webtransport',
  fallbackReason: null,
})

function fake(): {
  client: ObservableClient
  push: (r: Partial<FrameRecord>) => void
  observers: () => number
  setState: (s: ClientState) => void
  previewAsked: () => boolean | undefined
} {
  const observers = new Set<FrameObserver>()
  const listeners = new Set<() => void>()
  let state = connected
  let previewAsked: boolean | undefined
  const stats: SessionStats = {
    queueDepth: 0,
    overflowDropped: 0,
    staleDropped: 0,
    staleReceived: 0,
    directionDropped: 0,
  }
  return {
    client: {
      observe: (o, options) => {
        previewAsked = options?.preview
        observers.add(o)
        return () => void observers.delete(o)
      },
      subscribe: (l) => {
        listeners.add(l)
        return () => void listeners.delete(l)
      },
      getSnapshot: () => state,
      stats: () => stats,
    },
    push: (r) => {
      const record: FrameRecord = {
        at: 0,
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
    observers: () => observers.size,
    setState: (s) => {
      state = s
      for (const l of listeners) l()
    },
    previewAsked: () => previewAsked,
  }
}

describe('a real client', () => {
  test('frames, an open stream, and the snapshot all land in one state', async () => {
    const server = createServer<AppMap>({ contract })
    await server.listen()
    let release!: () => void
    const gate = new Promise<void>((r) => {
      release = r
    })
    server.handle('ask', async function* ({ n }) {
      for (let i = 0; i < n; i++) yield i
      await gate
    })
    const [serverSide, clientSide] = loopbackPair()
    const client = new Client<AppMap>({ contract, connect: async () => clientSide })
    const f = frames()
    const store = createStore(client, { schedule: f.schedule })
    await Promise.all([server.accept(serverSide), client.connect()])

    client.emit('chat', { body: 'hi' })
    const taken: number[] = []
    const streaming_ = (async () => {
      for await (const n of client.stream('ask', { n: 2 })) taken.push(n)
    })()
    await settle()

    const open = store.getSnapshot()
    expect(open.connection.status).toBe('connected')
    expect(open.stats).toEqual(client.stats() ?? null)
    expect(open.rows.map((r) => r.kind)).toContain('handshake')
    expect(open.streams).toEqual([
      expect.objectContaining({ stream: 1, event: 'ask', dir: 'out', frames: 3 }),
    ])
    expect(open.events).toEqual(['ask', 'chat'])

    release()
    await streaming_
    await settle()
    expect(taken).toEqual([0, 1])
    expect(store.getSnapshot().streams).toEqual([])

    store.destroy()
    client.disconnect()
  })
})

describe('what it keeps, and how often it says so', () => {
  test('a burst is one notification, and the snapshot is stable between changes', () => {
    const c = fake()
    const f = frames()
    const store = createStore(c.client, { schedule: f.schedule })
    let told = 0
    store.subscribe(() => told++)

    for (let i = 0; i < 500; i++) c.push({ at: i })
    expect(f.pending()).toBe(1)
    f.tick()
    expect(told).toBe(1)

    const a = store.getSnapshot()
    expect(store.getSnapshot()).toBe(a)
    expect(a.rows).toHaveLength(500)
    c.push({})
    expect(store.getSnapshot()).not.toBe(a)
  })

  test('the ring keeps the newest, and never more than its capacity', () => {
    const c = fake()
    const store = createStore(c.client, { capacity: 4, schedule: frames().schedule })
    for (let i = 1; i <= 10; i++) c.push({ at: i })
    const s = store.getSnapshot()
    expect(s.held).toBe(4)
    expect(s.rows.map((r) => r.at)).toEqual([7, 8, 9, 10])
  })

  test('the default capacity is 1,000', () => {
    const c = fake()
    const store = createStore(c.client, { schedule: frames().schedule })
    for (let i = 0; i < 1_500; i++) c.push({ at: i })
    expect(store.getSnapshot().held).toBe(1_000)
  })

  test('previews are asked for only when the option says so', () => {
    const plain = fake()
    createStore(plain.client, { schedule: frames().schedule })
    expect(plain.previewAsked()).toBeUndefined()

    const asked = fake()
    createStore(asked.client, { preview: true, schedule: frames().schedule })
    expect(asked.previewAsked()).toBe(true)
  })
})

describe('pause, filter, clear', () => {
  test('paused: the rows being read stay, what arrives is counted, and drops still count', () => {
    const c = fake()
    const store = createStore(c.client, { schedule: frames().schedule })
    c.push({ at: 1 })
    store.pause()
    c.push({ at: 2 })
    c.push({ at: 3, kind: 'overflow-dropped', event: 'cursor', lane: 'unreliable' })

    const paused = store.getSnapshot()
    expect(paused.paused).toBe(true)
    expect(paused.rows.map((r) => r.at)).toEqual([1])
    expect(paused.skipped).toBe(2)
    expect(paused.drops).toEqual([{ kind: 'overflow-dropped', event: 'cursor', count: 1 }])

    store.resume()
    c.push({ at: 4 })
    const resumed = store.getSnapshot()
    expect(resumed.rows.map((r) => r.at)).toEqual([1, 4])
    expect(resumed.skipped).toBe(0)
  })

  test('a filter by event, by lane, and by both', () => {
    const c = fake()
    const store = createStore(c.client, { schedule: frames().schedule })
    c.push({ at: 1, event: 'chat', lane: 'reliable' })
    c.push({ at: 2, event: 'cursor', lane: 'unreliable', kind: 'datagram' })
    c.push({ at: 3, event: null, kind: 'join' })

    const before = store.getSnapshot().epoch
    store.setFilter({ event: 'cursor' })
    expect(store.getSnapshot().rows.map((r) => r.at)).toEqual([2])
    expect(store.getSnapshot().epoch).toBeGreaterThan(before)

    store.setFilter({ event: null, lane: 'reliable' })
    expect(store.getSnapshot().rows.map((r) => r.at)).toEqual([1, 3])

    store.setFilter({ event: 'cursor', lane: 'reliable' })
    expect(store.getSnapshot().rows).toEqual([])
    // Filtered out is not thrown away.
    expect(store.getSnapshot().held).toBe(3)
  })

  test('clear empties the ring and the per-event drops', () => {
    const c = fake()
    const store = createStore(c.client, { schedule: frames().schedule })
    c.push({ kind: 'stale-received', event: 'cursor' })
    store.clear()
    const s = store.getSnapshot()
    expect(s.rows).toEqual([])
    expect(s.held).toBe(0)
    expect(s.drops).toEqual([])
  })
})

describe('streams and drops', () => {
  test('a stream is open from its open to its close, and counts what crosses it', () => {
    const c = fake()
    const store = createStore(c.client, { schedule: frames().schedule })
    c.push({ kind: 'open', dir: 'in', stream: 3, event: null, size: 0, at: 9 })
    c.push({ kind: 'request', dir: 'in', stream: 3, event: 'save', size: 30 })
    c.push({ kind: 'response', dir: 'out', stream: 3, event: 'save', size: 25 })
    expect(store.getSnapshot().streams).toEqual([
      { session: 1, stream: 3, event: 'save', dir: 'in', openedAt: 9, frames: 2, bytes: 55 },
    ])
    c.push({ kind: 'close', dir: 'in', stream: 3, event: null, size: 0 })
    expect(store.getSnapshot().streams).toEqual([])
  })

  test('a session that ends takes its open streams with it', () => {
    const c = fake()
    const store = createStore(c.client, { schedule: frames().schedule })
    c.push({ kind: 'open', dir: 'out', stream: 1, event: 'ask', size: 0 })
    c.setState({ ...connected, status: 'closed', transport: null, sessionId: null })
    expect(store.getSnapshot().streams).toEqual([])

    // And a new session's stream 1 is not the old one.
    c.push({ kind: 'open', dir: 'out', stream: 1, event: 'ask', size: 0 })
    c.push({ session: 2, kind: 'open', dir: 'out', stream: 1, event: 'save', size: 0 })
    expect(store.getSnapshot().streams.map((s) => `${s.session}:${s.event}`)).toEqual([
      '2:save',
    ])
  })

  test('drops are counted per kind and per event, most first', () => {
    const c = fake()
    const store = createStore(c.client, { schedule: frames().schedule })
    for (let i = 0; i < 3; i++) c.push({ kind: 'overflow-dropped', event: 'cursor' })
    c.push({ kind: 'stale-received', event: 'cursor' })
    c.push({ kind: 'direction-dropped', event: 'users' })
    c.push({ kind: 'direction-dropped', event: 'users' })
    expect(store.getSnapshot().drops).toEqual([
      { kind: 'overflow-dropped', event: 'cursor', count: 3 },
      { kind: 'direction-dropped', event: 'users', count: 2 },
      { kind: 'stale-received', event: 'cursor', count: 1 },
    ])
  })
})

describe('copying rows', () => {
  test('the text stands on its own in an issue: what it was taken from, then the rows', () => {
    const c = fake()
    const store = createStore(c.client, { schedule: frames().schedule })
    c.push({ at: Date.UTC(2026, 8, 17, 12, 0, 0, 5), event: 'chat', size: 21 })
    c.push({
      at: Date.UTC(2026, 8, 17, 12, 0, 1, 250),
      kind: 'datagram',
      dir: 'out',
      lane: 'unreliable',
      event: 'cursor',
      stream: null,
      size: 40,
      sequence: 7,
      preview: '{"x":1}',
    })

    expect(store.copy().split('\n')).toEqual([
      'transport-io devtools: connected, webtransport, s-1',
      'no lastError',
      'queueDepth 0, overflowDropped 0, staleDropped 0, staleReceived 0, directionDropped 0',
      'time\tsession\tdir\tlane\tkind\tevent\tstream\tsize\tseq\tpreview',
      '12:00:00.005\t1\tin\treliable\temit\tchat\t0\t21\t-\t',
      '12:00:01.250\t1\tout\tunreliable\tdatagram\tcursor\t-\t40\t7\t{"x":1}',
    ])
    // The newest rows, when the list shows fewer than the ring holds.
    expect(store.copy(1).split('\n')).toHaveLength(5)
    expect(formatRows(store.getSnapshot(), 0).split('\n')).toHaveLength(4)
  })

  test('a failed connect is in the header: the code, what was thrown, and the remedy', () => {
    const c = fake()
    const store = createStore(c.client, { schedule: frames().schedule })
    const closed = { ...connected, status: 'closed' as const, transport: null, sessionId: null }
    c.setState({
      ...closed,
      lastError: new TransportError(
        'WT_SESSION_CLOSED',
        "TypeError: Cannot read properties of undefined (reading 'digest')",
        'Read `cause`, which is what was thrown.',
        new TypeError("Cannot read properties of undefined (reading 'digest')"),
      ),
    })
    expect(store.copy().split('\n').slice(0, 2)).toEqual([
      'transport-io devtools: closed, no transport, no session',
      "lastError: WT_SESSION_CLOSED; cause: TypeError: Cannot read properties of undefined (reading 'digest'); remedy: Read `cause`, which is what was thrown.",
    ])

    // With no cause, the error's own sentence, without the code and remedy it already shows.
    c.setState({
      ...closed,
      lastError: new TransportError(
        'WT_UDP_UNREACHABLE',
        'the server answers over HTTPS but the WebTransport handshake failed',
        'Open UDP to the port.',
      ),
    })
    expect(store.copy().split('\n')[1]).toBe(
      'lastError: WT_UDP_UNREACHABLE; what: the server answers over HTTPS but the WebTransport handshake failed; remedy: Open UDP to the port.',
    )
  })
})

describe('leaving', () => {
  test('destroy unsubscribes from the client and cancels what was scheduled', () => {
    const c = fake()
    const f = frames()
    const store = createStore(c.client, { schedule: f.schedule })
    let told = 0
    store.subscribe(() => told++)
    c.push({})
    expect(c.observers()).toBe(1)

    store.destroy()
    expect(c.observers()).toBe(0)
    expect(f.pending()).toBe(0)
    f.tick()
    expect(told).toBe(0)
  })
})
