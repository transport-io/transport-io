/**
 * `client.observe()`: one record per frame, per call stream and per drop, and nothing kept.
 *
 * The drops are the point. `stats()` says how many; a record says which event, and no other
 * tool shows either. So each of the four counters is forced here and held against the records
 * that name it. See D149.
 *
 * Proves this normative statement, which names this file back. The link is checked from both
 * ends by `scripts/check-norms.ts`; see D82.
 *
 *   drop-is-a-second-record
 */
import { describe, expect, test } from 'bun:test'
import { Client } from './client.ts'
import { buildEventTable, bytes, defineContract, type MapOf, type$ } from './contract.ts'
import { FRAME_KINDS, type FrameRecord, PREVIEW_MAX_BYTES } from './observe.ts'
import {
  DATAGRAM_HEADER_BYTES,
  DATAGRAM_QUEUE_MAX,
  DATAGRAM_TTL_MS,
  FrameType,
  STREAM_CREDIT_REFILL,
  STREAM_FRAME_OVERHEAD_BYTES,
} from './protocol.ts'
import { createServer, type ServerPeer } from './server.ts'
import { Session } from './session.ts'
import { loopbackPair } from './transport/loopback.ts'
import type { Connection } from './transport/types.ts'
import { UnreliableConnection } from './transport/unreliable.ts'

const contract = defineContract({
  chat: { lane: 'reliable', payload: type$<{ body: string }>() },
  cursor: { lane: 'unreliable', payload: type$<{ n: number }>(), fallback: 'newest' },
  blob: { lane: 'reliable', payload: bytes() },
  save: {
    lane: 'reliable',
    payload: type$<{ text: string }>(),
    returns: type$<{ n: number }>(),
  },
  fail: {
    lane: 'reliable',
    payload: type$<{ text: string }>(),
    returns: type$<{ n: number }>(),
  },
  ask: { lane: 'reliable', payload: type$<{ n: number }>(), yields: type$<number>() },
  users: { lane: 'reliable', payload: type$<{ names: string[] }>(), from: 'client' },
})
interface AppMap extends MapOf<typeof contract> {}

const settle = async (n = 12): Promise<void> => {
  for (let i = 0; i < n; i++) await new Promise((r) => setTimeout(r, 1))
}

const size = (payload: unknown): number =>
  STREAM_FRAME_OVERHEAD_BYTES + new TextEncoder().encode(JSON.stringify(payload)).byteLength

interface Rig {
  readonly client: Client<AppMap>
  readonly peer: ServerPeer<AppMap>
  readonly records: FrameRecord[]
  readonly server: ReturnType<typeof createServer<AppMap>>
  flush(): void
  tick(ms: number): void
}

async function rig(
  opts: {
    preview?: boolean
    manualFlush?: boolean
    kind?: 'webtransport' | 'websocket'
    serverConn?: (raw: Connection) => Connection
  } = {},
): Promise<Rig> {
  const server = createServer<AppMap>({ contract })
  await server.listen()
  server.handle('save', async ({ text }) => ({ n: text.length }))
  server.handle('fail', async () => {
    throw new Error('no')
  })
  server.handle('ask', async function* ({ n }) {
    for (let i = 0; i < n; i++) yield i
  })
  const [serverRaw, clientSide] = loopbackPair(1024, opts.kind ?? 'webtransport')
  const serverSide = opts.serverConn?.(serverRaw) ?? serverRaw

  let clock = 1_000
  const pending: (() => void)[] = []
  const client = new Client<AppMap>({
    contract,
    connect: async () => clientSide,
    origin: 0xd0000001,
    now: () => clock,
    ...(opts.manualFlush === true
      ? { scheduleFlush: (f: () => void) => void pending.push(f) }
      : {}),
  })
  const records: FrameRecord[] = []
  client.observe((r) => records.push(r), opts.preview === true ? { preview: true } : undefined)
  const [peer] = await Promise.all([server.accept(serverSide), client.connect()])
  return {
    client,
    peer,
    records,
    server,
    flush: () => {
      for (const f of pending.splice(0, pending.length)) f()
    },
    tick: (ms) => {
      clock += ms
    },
  }
}

const of = (records: readonly FrameRecord[], kind: FrameRecord['kind']): FrameRecord[] =>
  records.filter((r) => r.kind === kind)

describe('a record for every frame', () => {
  test('each kind stands at the index of the frame type it names', () => {
    expect(FRAME_KINDS[FrameType.HANDSHAKE]).toBe('handshake')
    expect(FRAME_KINDS[FrameType.EMIT]).toBe('emit')
    expect(FRAME_KINDS[FrameType.CALL_REQUEST]).toBe('request')
    expect(FRAME_KINDS[FrameType.CALL_RESPONSE]).toBe('response')
    expect(FRAME_KINDS[FrameType.CALL_ERROR]).toBe('error')
    expect(FRAME_KINDS[FrameType.JOIN]).toBe('join')
    expect(FRAME_KINDS[FrameType.LEAVE]).toBe('leave')
    expect(FRAME_KINDS[FrameType.CALL_CREDIT]).toBe('credit')
    // Recorded as the datagram it carries, never as a frame.
    expect(FRAME_KINDS[FrameType.DATAGRAM]).toBeUndefined()
    expect(FRAME_KINDS.length).toBe(Object.keys(FrameType).length)
  })

  test('the handshake is seen both ways by an observer that subscribed before connect', async () => {
    const r = await rig()
    const hello = of(r.records, 'handshake')
    expect(hello.map((h) => h.dir).sort()).toEqual(['in', 'out'])
    for (const h of hello) {
      expect(h).toMatchObject({ session: 1, lane: 'reliable', event: null, stream: 0 })
    }
  })

  test('an emit out and an emit in, on stream 0, sized as the wire sees them', async () => {
    const r = await rig()
    r.client.on('chat', () => undefined)
    r.client.emit('chat', { body: 'up' })
    r.peer.emit('chat', { body: 'down, and longer' })
    await settle()

    const [out, back] = of(r.records, 'emit')
    expect(out).toEqual({
      at: 1_000,
      session: 1,
      kind: 'emit',
      dir: 'out',
      lane: 'reliable',
      event: 'chat',
      stream: 0,
      size: size({ body: 'up' }),
      sequence: null,
      preview: null,
    })
    expect(back).toMatchObject({
      dir: 'in',
      event: 'chat',
      size: size({ body: 'down, and longer' }),
    })
  })

  test('an inbound frame is recorded with nobody listening for its event', async () => {
    const r = await rig()
    r.peer.emit('chat', { body: 'unheard' })
    await settle()
    expect(of(r.records, 'emit').map((e) => e.dir)).toEqual(['in'])
  })

  test('a datagram has a sequence and no stream', async () => {
    const r = await rig()
    r.client.emit('cursor', { n: 1 })
    r.client.emit('cursor', { n: 2 })
    r.peer.emit('cursor', { n: 3 })
    await settle()

    const out = of(r.records, 'datagram').filter((d) => d.dir === 'out')
    expect(out.map((d) => d.sequence)).toEqual([1, 2])
    expect(out[0]).toMatchObject({
      lane: 'unreliable',
      event: 'cursor',
      stream: null,
      size: DATAGRAM_HEADER_BYTES + JSON.stringify({ n: 1 }).length,
    })
    const back = of(r.records, 'datagram').filter((d) => d.dir === 'in')
    expect(back).toHaveLength(1)
    expect(back[0]?.stream).toBeNull()
  })

  test('on the WebSocket mapping a datagram is on stream 0 and costs the frame around it', async () => {
    const r = await rig({ kind: 'websocket' })
    r.client.emit('cursor', { n: 1 })
    r.peer.emit('cursor', { n: 2 })
    await settle()

    const wire =
      STREAM_FRAME_OVERHEAD_BYTES + DATAGRAM_HEADER_BYTES + JSON.stringify({ n: 1 }).length
    const datagrams = of(r.records, 'datagram')
    expect(datagrams.map((d) => d.dir).sort()).toEqual(['in', 'out'])
    for (const d of datagrams) {
      expect(d).toMatchObject({ lane: 'unreliable', stream: 0, size: wire })
    }
    // The frame that wraps it is not a second record.
    expect(of(r.records, 'emit')).toHaveLength(0)
  })

  test('membership arrives as join and leave', async () => {
    const r = await rig()
    await r.peer.join('lobby')
    await r.peer.leave('lobby')
    await settle()
    expect(of(r.records, 'join')).toHaveLength(1)
    expect(of(r.records, 'leave')).toHaveLength(1)
    expect(of(r.records, 'join')[0]).toMatchObject({ dir: 'in', stream: 0, event: null })
  })
})

describe('a call stream, from open to close', () => {
  test('a call is open, request, response, close, on one numbered stream', async () => {
    const r = await rig()
    expect(await r.client.call('save', { text: 'four' })).toEqual({ n: 4 })
    await settle()

    const call = r.records.filter((x) => x.stream !== null && x.stream > 0)
    expect(call.map((x) => `${x.kind} ${x.dir}`)).toEqual([
      'open out',
      'request out',
      'response in',
      'close out',
    ])
    expect(new Set(call.map((x) => x.stream))).toEqual(new Set([1]))
    // A response carries event id 0 on the wire, and the record names the call anyway.
    expect(call.every((x) => x.event === 'save')).toBe(true)
    expect(call[0]?.size).toBe(0)
    expect(call[1]?.size).toBe(size({ text: 'four' }))
  })

  test('each call stream takes the next number', async () => {
    const r = await rig()
    await r.client.call('save', { text: 'a' })
    await r.client.call('save', { text: 'b' })
    expect(of(r.records, 'open').map((o) => o.stream)).toEqual([1, 2])
  })

  test('a responder that fails is an error record', async () => {
    const r = await rig()
    await expect(r.client.call('fail', { text: 'x' })).rejects.toThrow('no')
    const [error] = of(r.records, 'error')
    expect(error).toMatchObject({ dir: 'in', event: 'fail', stream: 1 })
    expect(of(r.records, 'close')).toHaveLength(1)
  })

  test('a stream records every element in and every credit out', async () => {
    const r = await rig()
    const take = STREAM_CREDIT_REFILL * 2
    expect(await r.client.stream('ask', { n: take }).toArray()).toHaveLength(take)
    await settle()

    expect(of(r.records, 'response')).toHaveLength(take)
    const credit = of(r.records, 'credit')
    expect(credit).toHaveLength(2)
    expect(credit[0]).toMatchObject({ dir: 'out', event: 'ask', stream: 1 })
    expect(of(r.records, 'close')).toHaveLength(1)
  })

  test('leaving a stream early still closes it', async () => {
    const r = await rig()
    for await (const n of r.client.stream('ask', { n: 1_000 })) if (n === 2) break
    await settle()
    expect(of(r.records, 'open')).toHaveLength(1)
    expect(of(r.records, 'close')).toHaveLength(1)
  })

  test('the responding side records the same stream from its end', async () => {
    // No server-side subscription exists yet, so the session is observed directly.
    const [serverSide, clientSide] = loopbackPair()
    const table = await buildEventTable(contract)
    const responder = new Session(serverSide, { table, origin: 1, side: 'server' })
    const records: FrameRecord[] = []
    responder.observe({ observer: (x) => records.push(x), preview: false, session: 1 })
    responder.handle('save', async () => ({ n: 1 }))
    const client = new Client<AppMap>({ contract, connect: async () => clientSide })
    await Promise.all([responder.start(), client.connect()])

    await client.call('save', { text: 'x' })
    await expect(client.call('fail', { text: 'x' })).rejects.toThrow()
    await settle()

    const served = records.filter((x) => x.stream !== null && x.stream > 0)
    expect(served.map((x) => `${x.stream} ${x.kind} ${x.dir}`)).toEqual([
      '1 open in',
      '1 request in',
      '1 response out',
      '1 close in',
      '2 open in',
      '2 request in',
      '2 error out',
      '2 close in',
    ])
    client.disconnect()
  })
})

describe('the four drops stats() counts, each one named', () => {
  test('overflow: the ring pushes out the oldest, and the record says which', async () => {
    const r = await rig({ manualFlush: true })
    for (let n = 1; n <= DATAGRAM_QUEUE_MAX + 3; n++) r.client.emit('cursor', { n })

    const dropped = of(r.records, 'overflow-dropped')
    expect(dropped).toHaveLength(r.client.stats()?.overflowDropped ?? -1)
    expect(dropped.map((d) => d.sequence)).toEqual([1, 2, 3])
    expect(dropped[0]).toMatchObject({ dir: 'out', lane: 'unreliable', event: 'cursor' })
    // It was recorded going out first: a drop is a second record, never instead of one.
    expect(of(r.records, 'datagram')).toHaveLength(DATAGRAM_QUEUE_MAX + 3)
  })

  test('stale: a flush delayed past the TTL discards, and the record says which', async () => {
    const r = await rig({ manualFlush: true })
    r.client.emit('cursor', { n: 1 })
    r.tick(DATAGRAM_TTL_MS)
    r.flush()

    const dropped = of(r.records, 'stale-dropped')
    expect(dropped).toHaveLength(r.client.stats()?.staleDropped ?? -1)
    expect(dropped).toHaveLength(1)
    expect(dropped[0]).toMatchObject({ dir: 'out', event: 'cursor', sequence: 1 })
  })

  test('stale received: a duplicate arrives, and is refused by the sequence gate', async () => {
    const r = await rig({
      serverConn: (raw) => new UnreliableConnection(raw, { duplicateAt: new Set([1]) }),
    })
    r.client.on('cursor', () => undefined)
    r.peer.emit('cursor', { n: 1 })
    await settle()

    expect(r.client.stats()?.staleReceived).toBe(1)
    const arrived = of(r.records, 'datagram').filter((d) => d.dir === 'in')
    const refused = of(r.records, 'stale-received')
    expect(arrived).toHaveLength(2)
    expect(refused).toHaveLength(1)
    expect(refused[0]).toMatchObject({
      dir: 'in',
      event: 'cursor',
      sequence: arrived[0]?.sequence,
    })
  })

  test('direction: the peer sends what only this side may send', async () => {
    // A raw session with no side, standing in for a server that ignores the direction.
    const [serverSide, clientSide] = loopbackPair()
    const rogue = new Session(serverSide, { table: await buildEventTable(contract), origin: 9 })
    const client = new Client<AppMap>({ contract, connect: async () => clientSide })
    const records: FrameRecord[] = []
    client.observe((x) => records.push(x))
    await Promise.all([rogue.start(), client.connect()])

    rogue.emit('users', { names: ['x'] })
    await settle()

    expect(client.stats()?.directionDropped).toBe(1)
    expect(of(records, 'direction-dropped')).toEqual([
      expect.objectContaining({
        dir: 'in',
        lane: 'reliable',
        event: 'users',
        stream: 0,
        size: size({ names: ['x'] }),
      }),
    ])
    client.disconnect()
  })
})

describe('off unless something subscribes', () => {
  test('unsubscribing stops the records, and subscribing late starts them', async () => {
    const server = createServer<AppMap>({ contract })
    await server.listen()
    const [serverSide, clientSide] = loopbackPair()
    const client = new Client<AppMap>({ contract, connect: async () => clientSide })
    await Promise.all([server.accept(serverSide), client.connect()])

    const records: FrameRecord[] = []
    const stop = client.observe((r) => records.push(r))
    client.emit('chat', { body: 'seen' })
    stop()
    client.emit('chat', { body: 'unseen' })
    await settle()
    // Subscribed after the handshake, so the first record is the emit.
    expect(records.map((r) => r.kind)).toEqual(['emit'])
  })

  test('a disposed session reports nothing, and keeps no observer', async () => {
    const [serverSide] = loopbackPair()
    const session = new Session(serverSide, {
      table: await buildEventTable(contract),
      origin: 1,
    })
    const records: FrameRecord[] = []
    const tap = { observer: (r: FrameRecord) => records.push(r), preview: false, session: 1 }
    session.observe(tap)
    session.dispose()
    // `sendFrame` reports before it queues, so a tap that survived disposal would show here.
    session.emit('chat', { body: 'late' })
    session.observe(tap)
    session.emit('chat', { body: 'later' })
    expect(records).toEqual([])
  })

  test('an observer that throws ends nothing, and does not starve the next', async () => {
    const r = await rig()
    const second: FrameRecord[] = []
    r.client.observe(() => {
      throw new Error('a broken panel')
    })
    r.client.observe((x) => second.push(x))
    let heard = 0
    r.peer.on('chat', () => heard++)

    r.client.emit('chat', { body: 'still delivered' })
    await settle()
    expect(heard).toBe(1)
    expect(second.map((x) => x.kind)).toEqual(['emit'])
    expect(r.client.getSnapshot().status).toBe('connected')
  })
})

describe('a preview, only for whoever asked', () => {
  test('off by default, and the start of the payload when asked for', async () => {
    const r = await rig({ preview: true })
    r.client.emit('chat', { body: 'hello' })
    expect(of(r.records, 'emit')[0]?.preview).toBe('{"body":"hello"}')
  })

  test(`capped at ${PREVIEW_MAX_BYTES} bytes, whatever the payload weighs`, async () => {
    const r = await rig({ preview: true })
    r.client.emit('chat', { body: 'x'.repeat(10_000) })
    expect(of(r.records, 'emit')[0]?.preview).toHaveLength(PREVIEW_MAX_BYTES)
    expect(PREVIEW_MAX_BYTES).toBe(256)
  })

  test('a bytes() payload previews as hex', async () => {
    const r = await rig({ preview: true })
    r.client.emit('blob', new Uint8Array([0, 15, 255]))
    expect(of(r.records, 'emit')[0]?.preview).toBe('000fff')
  })

  test('a subscriber that did not ask never sees one, whoever else did', async () => {
    const r = await rig({ preview: true })
    const bare: FrameRecord[] = []
    r.client.observe((x) => bare.push(x))
    r.client.emit('chat', { body: 'private' })
    expect(of(r.records, 'emit')[0]?.preview).toBe('{"body":"private"}')
    expect(of(bare, 'emit')[0]?.preview).toBeNull()
  })

  test('a record holds no bytes and no payload, only numbers and strings', async () => {
    const r = await rig({ preview: true })
    r.client.on('chat', () => undefined)
    r.client.emit('chat', { body: 'x' })
    r.client.emit('cursor', { n: 1 })
    r.peer.emit('chat', { body: 'y' })
    await r.client.call('save', { text: 'z' })
    await settle()

    expect(r.records.length).toBeGreaterThan(8)
    for (const record of r.records) {
      for (const value of Object.values(record)) {
        expect(value === null || ['number', 'string'].includes(typeof value)).toBe(true)
      }
    }
  })
})

describe('a reconnect is a new session, and the subscription carries over', () => {
  test('the second session is numbered 2 and seen by the same observer', async () => {
    const server = createServer<AppMap>({ contract })
    await server.listen()
    const pairs = [loopbackPair(), loopbackPair()]
    let dial = 0
    const client = new Client<AppMap>({
      contract,
      connect: async () => (pairs[dial++] as (typeof pairs)[number])[1],
    })
    const records: FrameRecord[] = []
    client.observe((r) => records.push(r))

    await Promise.all([server.accept(pairs[0]?.[0] as Connection), client.connect()])
    client.emit('chat', { body: 'first' })
    client.disconnect()
    await Promise.all([server.accept(pairs[1]?.[0] as Connection), client.connect()])
    client.emit('chat', { body: 'second' })

    expect(of(records, 'emit').map((e) => e.session)).toEqual([1, 2])
    expect(of(records, 'handshake').filter((h) => h.session === 2)).toHaveLength(2)
    client.disconnect()
  })
})
