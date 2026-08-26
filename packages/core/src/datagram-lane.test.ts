/**
 * The datagram lane's failure behaviour, forced deliberately.
 *
 * Until this file existed the lane had never dropped anything: the loopback is reliable
 * and the real-QUIC test is one happy-path message, so the ring, the TTL, stale-drop,
 * dedupe and reordering were all unexercised. Waiting for a real network to produce them
 * is waiting for a flaky test to explain a bug.
 */
import { describe, expect, test } from 'bun:test'
import { Client } from './client.ts'
import { defineContract, type MapOf, type$ } from './contract.ts'
import { encodeDatagram } from './datagram.ts'
import { DATAGRAM_QUEUE_MAX, DATAGRAM_TTL_MS } from './protocol.ts'
import { createServer, type ServerPeer } from './server.ts'
import { loopbackPair } from './transport/loopback.ts'
import type { Connection } from './transport/types.ts'
import { UnreliableConnection, type UnreliableOptions } from './transport/unreliable.ts'

const contract = defineContract({
  cursor: { lane: 'datagram', payload: type$<{ n: number }>() },
  chat: { lane: 'stream', payload: type$<{ body: string }>() },
})
interface AppMap extends MapOf<typeof contract> {}

const settle = async (n = 12): Promise<void> => {
  for (let i = 0; i < n; i++) await new Promise((r) => setTimeout(r, 1))
}

interface Rig {
  readonly client: Client<AppMap>
  readonly peer: ServerPeer<AppMap>
  readonly received: number[]
  flush(): void
  now(t: number): void
}

async function rig(
  opts: { unreliable?: UnreliableOptions; manualFlush?: boolean } = {},
): Promise<Rig> {
  const server = createServer<AppMap>({ contract })
  await server.listen()

  const [serverSide, clientRaw] = loopbackPair()
  const clientSide: Connection =
    opts.unreliable === undefined
      ? clientRaw
      : new UnreliableConnection(clientRaw, opts.unreliable)

  const pending: (() => void)[] = []
  const client = new Client<AppMap>({
    contract,
    connect: async () => clientSide,
    origin: 0xd0000001,
    ...(opts.manualFlush === true
      ? { scheduleFlush: (f: () => void) => void pending.push(f) }
      : {}),
  })

  const received: number[] = []
  const [peer] = await Promise.all([server.accept(serverSide), client.connect()])
  peer.on('cursor', (p) => received.push(p.n))

  return {
    client,
    peer,
    received,
    flush: () => {
      const queued = pending.splice(0, pending.length)
      for (const f of queued) f()
    },
    now: () => undefined,
  }
}

describe('the ring drops OLDEST under a burst', () => {
  test(`a burst larger than ${DATAGRAM_QUEUE_MAX} keeps the newest and counts the rest`, async () => {
    const r = await rig({ manualFlush: true })

    // A synchronous burst: nothing flushes until the scheduler runs, so the ring fills.
    const burst = DATAGRAM_QUEUE_MAX + 40
    for (let n = 1; n <= burst; n++) r.client.emit('cursor', { n })

    const before = r.client.stats()
    expect(before?.overflowDropped).toBe(40)
    expect(before?.queueDepth).toBe(DATAGRAM_QUEUE_MAX)

    r.flush()
    await settle()

    // Oldest-first is the right end to lose: every datagram payload is last-write-wins,
    // so the stale ones are the ones worth dropping.
    expect(r.received.length).toBe(DATAGRAM_QUEUE_MAX)
    expect(r.received[0]).toBe(41)
    expect(r.received.at(-1)).toBe(burst)
  })

  test('dropping never throws — it is the lane’s advertised contract', async () => {
    const r = await rig({ manualFlush: true })
    expect(() => {
      for (let n = 0; n < 500; n++) r.client.emit('cursor', { n })
    }).not.toThrow()
    expect(r.client.stats()?.overflowDropped).toBe(500 - DATAGRAM_QUEUE_MAX)
  })
})

describe('the TTL discards at dequeue, which is what a stall needs', () => {
  test('a flush delayed past the TTL delivers nothing and counts staleDropped', async () => {
    let clock = 0
    const server = createServer<AppMap>({ contract })
    await server.listen()
    const [serverSide, clientSide] = loopbackPair()
    const pending: (() => void)[] = []
    const client = new Client<AppMap>({
      contract,
      connect: async () => clientSide,
      origin: 0xd0000002,
      scheduleFlush: (f) => void pending.push(f),
      now: () => clock,
    })
    const got: number[] = []
    const [peer] = await Promise.all([server.accept(serverSide), client.connect()])
    peer.on('cursor', (p) => got.push(p.n))

    for (let n = 1; n <= 5; n++) client.emit('cursor', { n })
    // The ring never overflowed — five frames, capacity sixty-four — so drop-oldest does
    // nothing here. Without a TTL these five stale positions would be delivered and the
    // application would render history.
    expect(client.stats()?.overflowDropped).toBe(0)

    clock = DATAGRAM_TTL_MS + 1
    for (const f of pending.splice(0)) f()
    await settle()

    expect(got).toEqual([])
    expect(client.stats()?.staleDropped).toBe(5)
  })

  test('overflow and staleness are counted separately, because the causes differ', async () => {
    const r = await rig({ manualFlush: true })
    for (let n = 0; n < DATAGRAM_QUEUE_MAX + 10; n++) r.client.emit('cursor', { n })
    const s = r.client.stats()
    // A slow consumer and a slow network must be distinguishable from the outside.
    expect(s?.overflowDropped).toBe(10)
    expect(s?.staleDropped).toBe(0)
  })
})

describe('loss, duplication and reordering on the wire', () => {
  test('a lost datagram is simply absent — no error, no gap-filling', async () => {
    const r = await rig({ unreliable: { dropAt: new Set([2, 4]) } })
    for (let n = 1; n <= 5; n++) {
      r.client.emit('cursor', { n })
      await settle(2)
    }
    await settle()
    expect(r.received).toEqual([1, 3, 5])
  })

  test('a duplicate is discarded by the sequence gate and counted', async () => {
    const r = await rig({ unreliable: { duplicateAt: new Set([2]) } })
    for (let n = 1; n <= 3; n++) {
      r.client.emit('cursor', { n })
      await settle(2)
    }
    await settle()
    expect(r.received).toEqual([1, 2, 3]) // delivered once, not twice
    expect(r.peer.stats().staleReceived).toBe(1)
  })

  test('an out-of-order arrival is discarded, not rendered as history', async () => {
    // Datagram 2 is held and released after 3, so it arrives stale.
    const r = await rig({ unreliable: { delayAt: new Set([2]) } })
    for (let n = 1; n <= 3; n++) {
      r.client.emit('cursor', { n })
      await settle(2)
    }
    await settle()
    expect(r.received).toEqual([1, 3]) // 2 arrived after 3 and lost
    expect(r.peer.stats().staleReceived).toBe(1)
  })

  test('the stream lane is untouched by any of it', async () => {
    const r = await rig({
      unreliable: { dropAt: new Set([1, 2, 3]), duplicateAt: new Set([4]) },
    })
    const chat: string[] = []
    r.peer.on('chat', (p) => chat.push(p.body))
    for (const body of ['a', 'b', 'c']) r.client.emit('chat', { body })
    await settle()
    // Reliable and ordered, whatever the datagram path is doing.
    expect(chat).toEqual(['a', 'b', 'c'])
  })
})

describe('oversize is refused by us, because the transport will not say', () => {
  test('a payload past the path limit raises rather than vanishing', async () => {
    const r = await rig()
    const huge = 'x'.repeat(2000)
    expect(() => r.client.emit('cursor', { n: 0, pad: huge } as never)).toThrow(
      /WT_DATAGRAM_TOO_LARGE/,
    )
  })

  test('the encoder refuses before the transport can silently discard', () => {
    expect(() =>
      encodeDatagram(
        { eventId: 1, origin: 1, sequence: 1, payload: new Uint8Array(2000) },
        1024,
      ),
    ).toThrow(/WT_DATAGRAM_TOO_LARGE/)
  })
})
