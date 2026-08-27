/**
 * What survives a disconnect, and what a rejecting adapter does to teardown.
 *
 * The three defects here share a shape with D69: each is on the half of a two-sided
 * lifecycle that no test drove. Every existing test connects and asserts; none of them
 * *disconnects* and asserts, so a per-disconnect leak was invisible. `scripts/soak.node.ts`
 * has the same blind spot by construction - it opens 500 sessions and closes none - which
 * is why `soak:churn` exists alongside these.
 *
 * The adapter half is worse than untested. `HostileAdapter.failNextJoin` and
 * `failNextLeave` were written for exactly these cases and set by no test in the repository,
 * and the conformance test named "join rejecting does not leave the peer half-joined from
 * core's view" asserted only that the client was still `connected` - a property that holds
 * whether or not the peer is half-joined.
 */
import { describe, expect, test } from 'bun:test'
import { Client } from './client.ts'
import { buildEventTable, defineContract, type MapOf, type$ } from './contract.ts'
import { createServer } from './server.ts'
import { Session } from './session.ts'
import { HostileAdapter } from './testing/hostile-adapter.ts'
import { loopbackPair } from './transport/loopback.ts'

const contract = defineContract({
  chat: { lane: 'stream', payload: type$<{ body: string }>() },
})
interface AppMap extends MapOf<typeof contract> {}

/**
 * Counts intervals that are started and never cleared. A leaked interval is not merely a
 * timer: its callback closes over the Session, which retains the Connection, the decoder,
 * both queues, the sequence gate and every handler set. `unref()` stops it holding the
 * loop open; it does not stop it retaining.
 */
function countLiveIntervals<T>(body: () => Promise<T>): Promise<{ result: T; live: number }> {
  const realSet = globalThis.setInterval
  const realClear = globalThis.clearInterval
  const live = new Set<unknown>()
  globalThis.setInterval = ((fn: () => void, ms: number) => {
    const h = realSet(fn, ms)
    live.add(h)
    return h
  }) as typeof globalThis.setInterval
  globalThis.clearInterval = ((h: unknown) => {
    live.delete(h)
    return realClear(h as Parameters<typeof realClear>[0])
  }) as typeof globalThis.clearInterval
  return body()
    .then((result) => ({ result, live: live.size }))
    .finally(() => {
      for (const h of live) realClear(h as Parameters<typeof realClear>[0])
      globalThis.setInterval = realSet
      globalThis.clearInterval = realClear
    })
}

/** Fails the test if anything rejects with nobody watching, rather than logging it. */
async function withUnhandledRejections<T>(
  body: () => Promise<T>,
): Promise<{ result: T; unhandled: unknown[] }> {
  const seen: unknown[] = []
  const onUnhandled = (e: unknown): void => {
    seen.push(e)
  }
  process.on('unhandledRejection', onUnhandled)
  try {
    const result = await body()
    // Rejections surface at the end of a turn, so give them one.
    await new Promise((r) => setTimeout(r, 60))
    return { result, unhandled: seen }
  } finally {
    process.off('unhandledRejection', onUnhandled)
  }
}

async function wire(adapter?: HostileAdapter) {
  const server = createServer<AppMap>({
    contract,
    ...(adapter === undefined ? {} : { adapter }),
  })
  await server.listen()
  const [serverSide, clientSide] = loopbackPair()
  const client = new Client<AppMap>({ contract, connect: async () => clientSide })
  const [peer] = await Promise.all([server.accept(serverSide), client.connect()])
  return { server, client, peer }
}

describe('a disconnect releases what the connection was holding', () => {
  test('25 normal connect/disconnect cycles leave no live sweep interval', async () => {
    const { live } = await countLiveIntervals(async () => {
      for (let i = 0; i < 25; i++) {
        const { client } = await wire()
        client.disconnect()
        await new Promise((r) => setTimeout(r, 5))
      }
    })
    // Was 25 - `clearInterval` appears in exactly one place, `Session.close()`, and
    // neither teardown continuation called it. Whichever side did not initiate the close
    // kept a live interval retaining its whole Session.
    expect(live).toBe(0)
  })

  test('a server-initiated close releases the peer side too', async () => {
    const { live } = await countLiveIntervals(async () => {
      for (let i = 0; i < 10; i++) {
        const { peer } = await wire()
        peer.close()
        await new Promise((r) => setTimeout(r, 5))
      }
    })
    expect(live).toBe(0)
  })
})

describe('an adapter that rejects degrades core rather than crashing it', () => {
  test('a leave rejection still removes the peer from EVERY room', async () => {
    const adapter = new HostileAdapter('n1')
    const { server, client, peer } = await wire(adapter)
    await peer.join('a')
    await peer.join('b')
    await peer.join('c')
    expect(server.memberCount('a')).toBe(1)

    adapter.failNextLeave = true // rejects on the first room of the teardown loop
    client.disconnect()
    await new Promise((r) => setTimeout(r, 80))

    // Was a=0 b=1 c=1 with peer.rooms still ["a","b","c"]: the throw escaped the loop
    // before rooms 2..N and before `#peerRooms.delete(id)`, and nothing retries -
    // `conn.closed` resolves once. A later `to('b').emit()` then fanned frames into a
    // dead session's queue.
    expect([server.memberCount('a'), server.memberCount('b'), server.memberCount('c')]).toEqual(
      [0, 0, 0],
    )
    expect(peer.rooms).toEqual([])
  })

  test('a leave rejection is not an unhandled rejection', async () => {
    const { unhandled } = await withUnhandledRejections(async () => {
      const adapter = new HostileAdapter('n1')
      const { client, peer } = await wire(adapter)
      await peer.join('a')
      adapter.failNextLeave = true
      client.disconnect()
      await new Promise((r) => setTimeout(r, 60))
    })
    // `void conn.closed.then(async () => …)` attached no `.catch`, so this ended the
    // process under Node's default. ADR/0005, D40 and API.md all promise the opposite.
    expect(unhandled).toEqual([])
  })

  test('a join rejection leaves the peer in no room and receiving no traffic', async () => {
    const adapter = new HostileAdapter('n1')
    const { server, client, peer } = await wire(adapter)

    const received: unknown[] = []
    client.on('chat', (p) => received.push(p))

    adapter.failNextJoin = true
    await expect(peer.join('lobby')).rejects.toThrow('join rejected')

    // Was memberCount 1, peer.rooms ["lobby"], and the emit below delivered: local state
    // was mutated before the await with no rollback, so the hub fanned to a peer the bus
    // had no record of and the client was never told it had joined. For a room whose join
    // is gated on authorization, that is traffic reaching someone who was refused.
    expect(server.memberCount('lobby')).toBe(0)
    expect(peer.rooms).toEqual([])

    await server.to('lobby').emit('chat', { body: 'must not arrive' })
    await new Promise((r) => setTimeout(r, 60))
    expect(received).toEqual([])
    expect(client.getSnapshot().rooms).toEqual([])
  })
})

describe('closing twice is not two closes', () => {
  test('the transport is told once, however many times close() is called', async () => {
    let closes = 0
    const [ours, theirs] = loopbackPair()
    void theirs
    const conn = new Proxy(ours, {
      get(t, p, r) {
        if (p === 'close')
          return (code: number, reason: string) => {
            closes++
            ;(t as unknown as { close: (c: number, r: string) => void }).close(code, reason)
          }
        const v = Reflect.get(t, p, r) as unknown
        return typeof v === 'function' ? v.bind(t) : v
      },
    })

    const session = new Session(conn as never, {
      table: await buildEventTable(contract),
      origin: 1,
    })
    void session.start().catch(() => undefined)
    await new Promise((r) => setTimeout(r, 5))

    session.close(0, 'first')
    session.close(0, 'second')
    session.close(0, 'third')

    // quiche logs "WebTransportHttp3 close sent twice" and refuses the extra ones. A client
    // disconnecting while the server tears the same session down is ordinary, so this fired
    // routinely under the soak - a protocol-level complaint we generated and ignored.
    expect(closes).toBe(1)
  })
})
