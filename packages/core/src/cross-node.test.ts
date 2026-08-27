/**
 * Two servers, one bus, distinct node ids.
 *
 * `Hub`'s remote-delivery branch - the `onRemote` callback in its constructor - had never
 * executed a single line in any test. Every server-backed test pairs one server with one
 * adapter whose `nodeId` matches, so the `if (e.nodeId === this.#nodeId) return` guard
 * always returned early, and local fan-out never goes through the bus at all. Inverting
 * that one condition kills all cross-node delivery and would have shipped green.
 *
 * That is the entire cross-node correctness story, in a library whose README advertises an
 * adapter boundary. D22 keeps Redis out of v1, but the *boundary* is v1, and this is what
 * the boundary is for.
 *
 * Also here: `getSnapshot()`'s referential stability, which API.md and D38 both claim has
 * "an explicit test pinning it". Every call site in every test read `.status` or `.rooms`
 * immediately; not one compared two calls for identity. The behaviour was correct and the
 * coverage claim was false, which is the cheaper half of the same failure.
 */
import { describe, expect, test } from 'bun:test'
import { MemoryAdapter, memoryBus } from './adapter.ts'
import { Client } from './client.ts'
import { defineContract, type MapOf, type$ } from './contract.ts'
import { createServer } from './server.ts'
import { HostileAdapter } from './testing/hostile-adapter.ts'
import { loopbackPair } from './transport/loopback.ts'

const contract = defineContract({
  chat: { lane: 'reliable', payload: type$<{ body: string }>() },
})
interface AppMap extends MapOf<typeof contract> {}

/**
 * One adapter per node, sharing a `memoryBus()`. Sharing a single adapter instance across
 * two servers looks like the same thing and is not: the envelope's `nodeId` comes from the
 * adapter, so one instance means one identity, and the dedup guard then either fires for
 * everyone or for no one.
 */
async function node(id: string, adapter: MemoryAdapter | HostileAdapter) {
  const server = createServer<AppMap>({ contract, adapter, nodeId: id })
  await server.listen()
  const [serverSide, clientSide] = loopbackPair()
  const client = new Client<AppMap>({ contract, connect: async () => clientSide })
  const [peer] = await Promise.all([server.accept(serverSide), client.connect()])
  return { server, client, peer }
}

describe('a broadcast on one node reaches a peer on another', () => {
  test('the remote branch delivers, and delivers exactly once', async () => {
    const bus = memoryBus()
    const a = await node('node-a', new MemoryAdapter('node-a', bus))
    const b = await node('node-b', new MemoryAdapter('node-b', bus))

    const seenOnB: unknown[] = []
    b.client.on('chat', (p) => seenOnB.push(p))
    await a.peer.join('lobby')
    await b.peer.join('lobby')

    await a.server.to('lobby').emit('chat', { body: 'from node-a' })
    await new Promise((r) => setTimeout(r, 80))

    // Exactly once, not twice: a node receiving its own publish back is normal, so core
    // dedupes by origin node rather than trusting the bus to suppress it.
    expect(seenOnB).toEqual([{ body: 'from node-a' }])
  })

  test('the originating node does not deliver its own publish twice', async () => {
    const bus = memoryBus()
    const a = await node('node-a', new MemoryAdapter('node-a', bus))
    await node('node-b', new MemoryAdapter('node-b', bus))

    const seenOnA: unknown[] = []
    a.client.on('chat', (p) => seenOnA.push(p))
    await a.peer.join('lobby')

    await a.server.to('lobby').emit('chat', { body: 'once' })
    await new Promise((r) => setTimeout(r, 80))
    expect(seenOnA).toEqual([{ body: 'once' }])
  })

  test('`except` is honoured across the bus, not only locally', async () => {
    const bus = memoryBus()
    const a = await node('node-a', new MemoryAdapter('node-a', bus))
    const b = await node('node-b', new MemoryAdapter('node-b', bus))

    const seenOnB: unknown[] = []
    b.client.on('chat', (p) => seenOnB.push(p))
    await a.peer.join('lobby')
    await b.peer.join('lobby')

    await a.server.to('lobby').except(b.peer.id).emit('chat', { body: 'not for b' })
    await new Promise((r) => setTimeout(r, 80))
    expect(seenOnB).toEqual([])
  })

  test('a peer that left is not reached from another node', async () => {
    const bus = memoryBus()
    const a = await node('node-a', new MemoryAdapter('node-a', bus))
    const b = await node('node-b', new MemoryAdapter('node-b', bus))

    const seenOnB: unknown[] = []
    b.client.on('chat', (p) => seenOnB.push(p))
    await a.peer.join('lobby')
    await b.peer.join('lobby')
    await b.peer.leave('lobby')

    await a.server.to('lobby').emit('chat', { body: 'after leave' })
    await new Promise((r) => setTimeout(r, 80))
    expect(seenOnB).toEqual([])
  })

  test('it still works over the hostile adapter, which reorders and duplicates', async () => {
    const hostile = { latencyMs: 5, reorder: true, duplicate: true }
    const bus = memoryBus()
    const a = await node('node-a', new HostileAdapter('node-a', hostile, bus))
    const b = await node('node-b', new HostileAdapter('node-b', hostile, bus))

    const seenOnB: unknown[] = []
    b.client.on('chat', (p) => seenOnB.push(p))
    await a.peer.join('lobby')
    await b.peer.join('lobby')

    await a.server.to('lobby').emit('chat', { body: 'hostile' })
    await new Promise((r) => setTimeout(r, 150))

    // A real bus is at-least-once, so the duplicate is expected on the wire. What must not
    // happen is the reliable lane losing it entirely.
    expect(seenOnB.length).toBeGreaterThanOrEqual(1)
    expect(seenOnB[0]).toEqual({ body: 'hostile' })
  })
})

describe('getSnapshot is referentially stable', () => {
  test('two calls with no state change return the same object', async () => {
    const a = await node('node-a', new MemoryAdapter('node-a'))

    const first = a.client.getSnapshot()
    const second = a.client.getSnapshot()
    // The claim API.md and D38 both make. `useSyncExternalStore` re-renders on every call
    // that returns a new object, so a fresh object here is an infinite render loop in
    // React - which is the reason the guarantee exists and the reason nobody noticed it
    // was only ever asserted by reading a field off the result.
    expect(first).toBe(second)
  })

  test('it returns a new object when state actually changes', async () => {
    const a = await node('node-a', new MemoryAdapter('node-a'))

    const before = a.client.getSnapshot()
    await a.peer.join('lobby')
    await new Promise((r) => setTimeout(r, 40))
    const after = a.client.getSnapshot()

    // Stability must not be achieved by never changing: that would be a store that never
    // re-renders, which is the opposite failure and just as silent.
    expect(after).not.toBe(before)
    expect(after.rooms).toEqual(['lobby'])
  })
})
