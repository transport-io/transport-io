/**
 * The adapter conformance suite. It runs against BOTH implementations.
 *
 * An interface with one implementor is usually wrong, and `MemoryAdapter` is the
 * misleading kind: synchronous, infallible, object-passing, omniscient about membership.
 * Every test below runs twice — once against it, once against `HostileAdapter`, which is
 * none of those things. A rule that only holds for the easy one is not a rule core can
 * rely on.
 */
import { describe, expect, test } from 'bun:test'
import { type Adapter, MemoryAdapter, type RemoteEnvelope } from './adapter.ts'
import { Client } from './client.ts'
import { defineContract, type MapOf, type$ } from './contract.ts'
import { createServer } from './server.ts'
import { HostileAdapter } from './testing/hostile-adapter.ts'
import { loopbackPair } from './transport/loopback.ts'

const contract = defineContract({
  chat: { lane: 'stream', payload: type$<{ body: string }>() },
  cursor: { lane: 'datagram', payload: type$<{ n: number }>() },
})
interface AppMap extends MapOf<typeof contract> {}

const settle = async (n = 20): Promise<void> => {
  for (let i = 0; i < n; i++) await new Promise((r) => setTimeout(r, 1))
}

interface Impl {
  readonly name: string
  make(nodeId: string): Adapter
  readonly hostile: boolean
}

const IMPLEMENTATIONS: Impl[] = [
  { name: 'MemoryAdapter', make: (id) => new MemoryAdapter(id), hostile: false },
  {
    name: 'HostileAdapter',
    make: (id) => new HostileAdapter(id, { latencyMs: 1, reorder: true, duplicate: true }),
    hostile: true,
  },
]

for (const impl of IMPLEMENTATIONS) {
  describe(`adapter conformance: ${impl.name}`, () => {
    test('every method is async, even in memory', () => {
      const a = impl.make('n1')
      expect(a.join('r', 'p')).toBeInstanceOf(Promise)
      expect(a.leave('r', 'p')).toBeInstanceOf(Promise)
      expect(a.broadcast('r', new Uint8Array([1]), { lane: 'stream' })).toBeInstanceOf(Promise)
    })

    test('frames cross as bytes and survive the round trip intact', async () => {
      const a = impl.make('n1')
      const seen: RemoteEnvelope[] = []
      a.onRemote((e) => seen.push(e))
      const sent = new Uint8Array([0, 1, 2, 250, 255])
      await a.broadcast('room', sent, { lane: 'stream' })
      await settle()

      expect(seen.length).toBeGreaterThan(0)
      const got = seen[0] as RemoteEnvelope
      expect(got.frame).toBeInstanceOf(Uint8Array)
      expect([...got.frame]).toEqual([...sent])
      // Not the same object: a live reference would not survive a real bus.
      if (impl.hostile) expect(got.frame).not.toBe(sent)
    })

    test('the publisher receives its own message back', async () => {
      const a = impl.make('self')
      const nodes: string[] = []
      a.onRemote((e) => nodes.push(e.nodeId))
      await a.broadcast('room', new Uint8Array([1]), { lane: 'stream' })
      await settle()
      expect(nodes.length).toBeGreaterThan(0)
      expect(nodes.every((n) => n === 'self')).toBe(true)
    })

    test('the lane and the exclusion list survive the boundary', async () => {
      const a = impl.make('n1')
      const seen: RemoteEnvelope[] = []
      a.onRemote((e) => seen.push(e))
      await a.broadcast('room', new Uint8Array([9]), { lane: 'datagram', except: ['peer-1'] })
      await settle()
      const got = seen[0] as RemoteEnvelope
      expect(got.lane).toBe('datagram')
      expect(got.except).toEqual(['peer-1'])
    })

    test('a rejected broadcast does not crash core — the session stays up', async () => {
      // The server's OWN adapter must fail, not a bystander. Failing a separate instance
      // would assert nothing about how core handles rejection.
      const adapter = impl.make('n1')
      const server = createServer<AppMap>({ adapter, contract, nodeId: 'n1' })
      await server.listen()
      const [serverSide, clientSide] = loopbackPair()
      const client = new Client<AppMap>({ contract, connect: async () => clientSide })
      const [peer] = await Promise.all([server.accept(serverSide), client.connect()])
      await peer.join('lobby')
      const got: string[] = []
      client.on('chat', (p) => got.push(p.body))
      await settle()

      if (impl.hostile) {
        ;(adapter as HostileAdapter).failNextBroadcast = true
      }

      // Core must swallow the rejection: local members are already served and every
      // session stays up. A throw here would take the application down with the bus.
      await expect(
        server.to('lobby').emit('chat', { body: 'delivered locally' }),
      ).resolves.toBeUndefined()
      await settle(30)

      expect(got).toEqual(['delivered locally'])
      expect(client.getSnapshot().status).toBe('connected')

      // And the adapter recovers: the next broadcast is not poisoned by the last.
      await expect(
        server.to('lobby').emit('chat', { body: 'and again' }),
      ).resolves.toBeUndefined()
      await settle(30)
      expect(got).toEqual(['delivered locally', 'and again'])
    })

    test('a frame for a room with no local members is dropped silently', async () => {
      const server = createServer<AppMap>({ adapter: impl.make('n1'), contract, nodeId: 'n1' })
      await server.listen()
      await expect(
        server.to('nobody-here').emit('chat', { body: 'x' }),
      ).resolves.toBeUndefined()
    })

    test('core dedupes its own publish rather than delivering it twice', async () => {
      const adapter = impl.make('n1')
      const server = createServer<AppMap>({ adapter, contract, nodeId: 'n1' })
      await server.listen()

      const [aServer, aClient] = loopbackPair()
      const [bServer, bClient] = loopbackPair()
      const ca = new Client<AppMap>({ contract, connect: async () => aClient, origin: 0xe1 })
      const cb = new Client<AppMap>({ contract, connect: async () => bClient, origin: 0xe2 })
      const [pa] = await Promise.all([server.accept(aServer), ca.connect()])
      const [pb] = await Promise.all([server.accept(bServer), cb.connect()])
      await pa.join('lobby')
      await pb.join('lobby')

      const got: string[] = []
      cb.on('chat', (p) => got.push(p.body))
      await settle()

      await server.to('lobby').emit('chat', { body: 'once' })
      await settle(40)

      // The adapter echoes the publish back — and duplicates it, in the hostile case.
      // Core must recognise its own node and deliver exactly one copy locally.
      expect(got).toEqual(['once'])
    })

    test('membership is the adapter’s, and core never assumes it knows the whole room', async () => {
      const a = impl.make('n1')
      await a.join('lobby', 'peer-1')
      await a.join('lobby', 'peer-2')
      await a.leave('lobby', 'peer-1')
      // There is deliberately no `members()` on the interface: a node that could ask
      // would grow code that assumes the answer is complete, which it never is.
      expect('members' in a).toBe(false)
    })
  })
}

describe('hostility the memory adapter cannot express', () => {
  test('delivery is reordered and core still delivers each message once', async () => {
    const adapter = new HostileAdapter('n1', { latencyMs: 1, reorder: true, duplicate: true })
    const server = createServer<AppMap>({ adapter, contract, nodeId: 'n1' })
    await server.listen()

    const [srv, cli] = loopbackPair()
    const client = new Client<AppMap>({ contract, connect: async () => cli, origin: 0xe3 })
    const [peer] = await Promise.all([server.accept(srv), client.connect()])
    await peer.join('lobby')

    const got: string[] = []
    client.on('chat', (p) => got.push(p.body))
    await settle()

    for (const body of ['a', 'b', 'c']) await server.to('lobby').emit('chat', { body })
    await adapter.settle()
    await settle(40)

    // Local delivery does not round-trip the bus, so ordering here is ours, not the
    // adapter's — which is exactly why the reordering does not corrupt it.
    expect(got).toEqual(['a', 'b', 'c'])
  })

  test('join rejecting does not leave the peer half-joined from core’s view', async () => {
    const adapter = new HostileAdapter('n1', { latencyMs: 1 })
    const server = createServer<AppMap>({ adapter, contract, nodeId: 'n1' })
    await server.listen()
    const [srv, cli] = loopbackPair()
    const client = new Client<AppMap>({ contract, connect: async () => cli, origin: 0xe4 })
    const [peer] = await Promise.all([server.accept(srv), client.connect()])

    adapter.failNextJoin = true
    await expect(peer.join('lobby')).rejects.toThrow()

    // The session must survive an adapter fault.
    expect(client.getSnapshot().status).toBe('connected')
    await expect(server.to('other').emit('chat', { body: 'fine' })).resolves.toBeUndefined()
  })
})
