import { describe, expect, test } from 'bun:test'
import fc from 'fast-check'
import type { Publisher } from './adapter.ts'
import { MemoryAdapter } from './adapter.ts'
import {
  buildEventTable,
  defineContract,
  type EventEntry,
  eventIdOf,
  type$,
} from './contract.ts'
import { decodeDatagram, encodeDatagram, maxDatagramPayload, SequenceGate } from './datagram.ts'
import { TransportError } from './errors.ts'
import {
  buildHandshake,
  negotiate,
  parseHandshake,
  RESERVED_FEATURES,
  type WireEvent,
} from './handshake.ts'
import { OriginAllocator } from './origin.ts'
import { DATAGRAM_HEADER_BYTES, MAX_SESSION_HOSTS, ORIGIN_QUARANTINE_MS } from './protocol.ts'
import { DatagramQueue, EmitQueue, PeerTooSlowError } from './queue.ts'

describe('event identity', () => {
  test('is the first four bytes of SHA-256 of the name, big-endian', async () => {
    // Cross-checked against an independent implementation, not recalled.
    expect(await eventIdOf('chat')).toBe(836792189)
    expect(await eventIdOf('cursor')).toBe(1185214141)
    expect(await eventIdOf('save')).toBe(360565394)
  })

  test('is stable under insertion — the whole reason it is not positional', async () => {
    const before = await buildEventTable(
      defineContract({
        chat: { lane: 'stream', payload: type$<unknown>() },
        cursor: { lane: 'datagram', payload: type$<unknown>() },
      }),
    )
    const after = await buildEventTable(
      defineContract({
        archive: { lane: 'stream', payload: type$<unknown>() }, // sorts first
        chat: { lane: 'stream', payload: type$<unknown>() },
        cursor: { lane: 'datagram', payload: type$<unknown>() },
      }),
    )
    // Positional ids would have shifted both existing events by one.
    expect(after.byName('chat')?.id).toBe(before.byName('chat')?.id as number)
    expect(after.byName('cursor')?.id).toBe(before.byName('cursor')?.id as number)
  })

  test('a collision is a build-time error naming both events and the fix', async () => {
    const id = await eventIdOf('chat')
    const contract = defineContract({
      chat: { lane: 'stream', payload: type$<unknown>() },
      other: { lane: 'stream', payload: type$<unknown>(), id },
    })
    try {
      await buildEventTable(contract)
      throw new Error('expected a throw')
    } catch (e) {
      expect((e as TransportError).code).toBe('WT_CONTRACT_MISMATCH')
      expect((e as TransportError).message).toContain('chat')
      expect((e as TransportError).message).toContain('other')
      expect((e as TransportError).remedy).toContain('Do not rename your events')
    }
  })

  test('the reserved id 0 is refused', async () => {
    await expect(
      buildEventTable(
        defineContract({ x: { lane: 'stream', payload: type$<unknown>(), id: 0 } }),
      ),
    ).rejects.toThrow(TransportError)
  })

  test('entries expose name, id and lane for the wire table', async () => {
    const t = await buildEventTable(
      defineContract({ chat: { lane: 'stream', payload: type$<unknown>() } }),
    )
    const entry = t.byName('chat') as EventEntry
    expect(entry.lane).toBe('stream')
    expect(t.wire()).toEqual([['chat', entry.id, 'stream']])
  })
})

describe('handshake negotiation', () => {
  const table = async (c: Parameters<typeof buildEventTable>[0]) => await buildEventTable(c)
  const base = defineContract({
    chat: { lane: 'stream', payload: type$<unknown>() },
    cursor: { lane: 'datagram', payload: type$<unknown>() },
  })

  test('reserved feature tokens are declared, not invented at the call site', () => {
    expect(RESERVED_FEATURES).toContain('emit-per-room')
    expect(RESERVED_FEATURES).toContain('codec-msgpack')
    expect(RESERVED_FEATURES).toContain('session-resume')
  })

  test('an added event is NOT a mismatch — additive change is rolling-deploy safe', async () => {
    const local = buildHandshake(await table(base))
    const peer = buildHandshake(
      await table({ ...base, typing: { lane: 'stream', payload: type$<unknown>() } }),
    )
    const n = negotiate(local, peer)
    expect(n.peerOnly).toEqual(['typing'])
    expect(n.localOnly).toEqual([])
  })

  test('a lane disagreement IS a mismatch — it is a guarantee, not a detail', async () => {
    const local = buildHandshake(await table(base))
    const peer = buildHandshake(
      await table({ ...base, cursor: { lane: 'stream', payload: type$<unknown>() } }),
    )
    try {
      negotiate(local, peer)
      throw new Error('expected a throw')
    } catch (e) {
      expect((e as TransportError).code).toBe('WT_CONTRACT_MISMATCH')
      expect((e as TransportError).message).toContain('cursor')
    }
  })

  test('an id disagreement for the same name IS a mismatch', async () => {
    const local = buildHandshake(await table(base))
    const events = local.events.map((e) =>
      e[0] === 'chat' ? (['chat', 999, 'stream'] as WireEvent) : e,
    )
    expect(() => negotiate(local, { ...local, events })).toThrow(TransportError)
  })

  test('a version mismatch refuses the session', async () => {
    const local = buildHandshake(await table(base))
    try {
      negotiate(local, { ...local, v: 1 })
      throw new Error('expected a throw')
    } catch (e) {
      expect((e as TransportError).code).toBe('WT_PROTOCOL_VERSION_MISMATCH')
    }
  })

  test('feat is the intersection and never fatal', async () => {
    const t = await table(base)
    const local = buildHandshake(t, ['emit-per-room', 'codec-msgpack'])
    const peer = buildHandshake(t, ['codec-msgpack', 'unknown-future-token'])
    expect(negotiate(local, peer).feat).toEqual(['codec-msgpack'])
  })

  test('a malformed handshake is a protocol error, not a crash', () => {
    for (const bad of [null, 42, {}, { v: 0 }, { v: 0, feat: [], events: [['x', 'y', 'z']] }]) {
      expect(() => parseHandshake(bad)).toThrow(TransportError)
    }
  })
})

describe('datagram lane', () => {
  test('header is 13 bytes and the payload budget derives from the path', () => {
    expect(maxDatagramPayload(1024)).toBe(1024 - DATAGRAM_HEADER_BYTES)
    expect(maxDatagramPayload(1211)).toBe(1211 - DATAGRAM_HEADER_BYTES)
    expect(maxDatagramPayload(0)).toBe(1024 - DATAGRAM_HEADER_BYTES) // floor when unreported
  })

  test('oversized is refused by us, because the transport reports success and discards', () => {
    const payload = new Uint8Array(maxDatagramPayload(1024) + 1)
    try {
      encodeDatagram({ eventId: 1, origin: 2, sequence: 3, payload }, 1024)
      throw new Error('expected a throw')
    } catch (e) {
      expect((e as TransportError).code).toBe('WT_DATAGRAM_TOO_LARGE')
    }
  })

  test('round-trips origin and sequence for any values', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 0xffffffff }),
        fc.integer({ min: 0, max: 0xffffffff }),
        fc.integer({ min: 1, max: 0xffffffff }),
        fc.uint8Array({ minLength: 1, maxLength: 200 }),
        (eventId, origin, sequence, payload) => {
          const back = decodeDatagram(
            encodeDatagram({ eventId, origin, sequence, payload }, 1024),
          )
          expect(back.eventId).toBe(eventId)
          expect(back.origin).toBe(origin)
          expect(back.sequence).toBe(sequence)
          expect([...back.payload]).toEqual([...payload])
        },
      ),
      { numRuns: 300 },
    )
  })
})

describe('sequence gate keys on origin, not session', () => {
  test('two origins do not starve each other', () => {
    const g = new SequenceGate()
    // The session-scoped alternative fails exactly here: a peer at 3000 would make a peer
    // starting at 1 permanently stale.
    expect(g.accept(0xaaaa, 7, 3000, 0)).toBe(true)
    expect(g.accept(0xbbbb, 7, 1, 0)).toBe(true)
    expect(g.accept(0xbbbb, 7, 2, 0)).toBe(true)
  })

  test('stale and duplicate are discarded and counted', () => {
    const g = new SequenceGate()
    expect(g.accept(1, 1, 10, 0)).toBe(true)
    expect(g.accept(1, 1, 9, 0)).toBe(false)
    expect(g.accept(1, 1, 10, 0)).toBe(false)
    expect(g.staleReceived).toBe(2)
  })

  test('wrap is circular, not a regression', () => {
    const g = new SequenceGate()
    expect(g.accept(1, 1, 0xfffffffe, 0)).toBe(true)
    expect(g.accept(1, 1, 2, 0)).toBe(true) // wrapped forward
    expect(g.accept(1, 1, 0xfffffff0, 0)).toBe(false) // genuinely behind
  })

  test('state is swept so origins can be reused', () => {
    const g = new SequenceGate()
    g.accept(1, 1, 5, 0)
    expect(g.tracked).toBe(1)
    g.sweep(60_000, 60_000)
    expect(g.tracked).toBe(0)
  })
})

describe('backpressure', () => {
  test('datagram lane drops OLDEST and never throws', () => {
    const q = new DatagramQueue<number>(4, 1000)
    for (let i = 0; i < 6; i++) q.push(i, 0)
    expect(q.drain(0)).toEqual([2, 3, 4, 5])
    expect(q.stats().overflowDropped).toBe(2)
  })

  test('TTL is checked at DEQUEUE, which is what a stall needs', () => {
    const q = new DatagramQueue<string>(64, 150)
    q.push('stale', 0)
    q.push('fresh', 1000)
    // The ring never overflowed, so drop-oldest would have delivered both and the app
    // would render history.
    expect(q.drain(1000)).toEqual(['fresh'])
    expect(q.stats().staleDropped).toBe(1)
    expect(q.stats().overflowDropped).toBe(0)
  })

  test('emit lane never drops — it disconnects instead', () => {
    const q = new EmitQueue<number>(3)
    q.push(1)
    q.push(2)
    q.push(3)
    expect(() => q.push(4)).toThrow(PeerTooSlowError)
  })
})

describe('origin allocation', () => {
  test('never issues the reserved zero', () => {
    const a = new OriginAllocator(0)
    for (let i = 0; i < 50; i++) expect(a.allocate(0)).not.toBe(0)
  })

  test('a freed origin is quarantined, then reused — not retired', () => {
    const a = new OriginAllocator(0, 120_000)
    const first = a.allocate(0)
    a.free(first, 0)
    expect(a.stats(0).quarantined).toBe(1)

    // Still held at the boundary.
    a.allocate(119_999)
    expect(a.stats(119_999).quarantined).toBe(1)

    // Released once the window passes, so the counter is a capacity limit, not a clock.
    expect(a.stats(120_001).quarantined).toBe(0)
  })

  test('the quarantine exceeds both windows it must outlast', () => {
    // Sequence-state retention (60s) and the datagram TTL (150ms) plus transit.
    expect(ORIGIN_QUARANTINE_MS).toBeGreaterThan(60_000)
    expect(ORIGIN_QUARANTINE_MS).toBeGreaterThan(150)
  })

  test('host ordinals partition the space', () => {
    const a = new OriginAllocator(0)
    const b = new OriginAllocator(1)
    const fromA = new Set(Array.from({ length: 100 }, () => a.allocate(0)))
    const fromB = new Set(Array.from({ length: 100 }, () => b.allocate(0)))
    for (const v of fromB) expect(fromA.has(v)).toBe(false)
  })

  test('an ordinal past the stated ceiling is refused', () => {
    expect(() => new OriginAllocator(MAX_SESSION_HOSTS)).toThrow(TransportError)
  })
})

describe('adapter boundary', () => {
  test('a node receives its own publish back, and core must dedupe by node', async () => {
    const a = new MemoryAdapter('node-1')
    const seen: string[] = []
    a.onRemote((e) => seen.push(e.nodeId))
    await a.broadcast('lobby', new Uint8Array([1]), { lane: 'stream' })
    expect(seen).toEqual(['node-1'])
  })

  test('every method is async even in memory', async () => {
    const a = new MemoryAdapter('n')
    expect(a.join('r', 'p')).toBeInstanceOf(Promise)
    expect(a.leave('r', 'p')).toBeInstanceOf(Promise)
    expect(a.broadcast('r', new Uint8Array([1]), { lane: 'stream' })).toBeInstanceOf(Promise)
  })

  test('the write-only Publisher shape is satisfied by an Adapter', async () => {
    // Internal in this version: the interface is a design constraint, and a cross-process
    // implementation arrives with the Redis adapter.
    const p: Publisher = new MemoryAdapter('n')
    await expect(
      p.broadcast('r', new Uint8Array([1]), { lane: 'stream' }),
    ).resolves.toBeUndefined()
  })
})
