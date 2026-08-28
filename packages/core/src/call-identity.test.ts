/**
 * `ctx.peer`: a responder learns who called it.
 *
 * Before this existed, `CallContext` was `{ signal }` and a responder was registered on the
 * server rather than on a peer, so a call could not join its caller to a room or check that
 * caller's permissions. Every authenticated request had to be hand-rolled as a pair of
 * events, which is the bookkeeping `call()` exists to remove.
 *
 * The load-bearing assertion is not that `peer` is present. It is that two peers calling the
 * same responder each get their own, because a single shared peer would satisfy a
 * presence check and still be the bug.
 */
import { describe, expect, test } from 'bun:test'
import { Client } from './client.ts'
import { defineContract, type MapOf, reliable, rpc, streaming } from './contract.ts'
import { createServer, type Server, type ServerPeer } from './server.ts'
import { loopbackPair } from './transport/loopback.ts'

const contract = defineContract({
  joined: reliable<{ room: string }>(),
  whoAmI: rpc<null, { id: string; origin: number }>(),
  enter: rpc<{ room: string }, { rooms: readonly string[] }>(),
  countdown: streaming<{ from: number }, string>(),
})
interface AppMap extends MapOf<typeof contract> {}

async function wire(): Promise<{ server: Server<AppMap>; clients: Client<AppMap>[] }> {
  const server = createServer<AppMap>({ contract })
  await server.listen()
  return { server, clients: [] }
}

async function connect(server: Server<AppMap>): Promise<Client<AppMap>> {
  const [serverSide, clientSide] = loopbackPair()
  const client = new Client<AppMap>({ contract, connect: async () => clientSide })
  await Promise.all([server.accept(serverSide), client.connect()])
  return client
}

describe('a call handler receives the peer that called it', () => {
  test('two peers calling one responder each get their own', async () => {
    const { server } = await wire()
    server.handle('whoAmI', async (_p, ctx) => ({ id: ctx.peer.id, origin: ctx.peer.origin }))

    const a = await connect(server)
    const b = await connect(server)

    const seenA = await a.call('whoAmI', null)
    const seenB = await b.call('whoAmI', null)

    // Distinct, which is the assertion. A single shared peer would pass a presence check.
    expect(seenA.id).not.toBe(seenB.id)
    expect(seenA.origin).not.toBe(seenB.origin)

    a.disconnect()
    b.disconnect()
  })

  test('the handler can join its own caller, which was the impossible case', async () => {
    const { server } = await wire()
    server.handle('enter', async ({ room }, ctx) => {
      await ctx.peer.join(room)
      return { rooms: ctx.peer.rooms }
    })

    const a = await connect(server)
    const b = await connect(server)

    expect(await a.call('enter', { room: 'lobby' })).toEqual({ rooms: ['lobby'] })
    expect(server.memberCount('lobby')).toBe(1)

    // b joining does not disturb a, and the count reflects both.
    expect(await b.call('enter', { room: 'lobby' })).toEqual({ rooms: ['lobby'] })
    expect(server.memberCount('lobby')).toBe(2)

    a.disconnect()
    b.disconnect()
  })

  test('a rejected caller is not joined', async () => {
    const { server } = await wire()
    server.handle('enter', async ({ room }, ctx) => {
      if (room === 'staff') return { rooms: ctx.peer.rooms }
      await ctx.peer.join(room)
      return { rooms: ctx.peer.rooms }
    })

    const a = await connect(server)
    expect(await a.call('enter', { room: 'staff' })).toEqual({ rooms: [] })
    expect(server.memberCount('staff')).toBe(0)

    a.disconnect()
  })
})

describe('a streaming handler receives it too', () => {
  test('the generator sees the calling peer', async () => {
    const { server } = await wire()
    server.handle('countdown', async function* ({ from }, ctx) {
      for (let i = from; i > 0; i--) yield `${ctx.peer.id}:${i}`
    })

    const a = await connect(server)
    const out = await a.stream('countdown', { from: 2 }).toArray()

    expect(out).toHaveLength(2)
    // Every element carries the same peer id, and it is a real one.
    const ids = new Set(out.map((s) => s.split(':').slice(0, -1).join(':')))
    expect(ids.size).toBe(1)
    expect([...ids][0]).toMatch(/:\d+$/)

    a.disconnect()
  })
})

describe('the peer is attached before any handler can run', () => {
  test('a responder registered before the peer connected still sees it', async () => {
    const { server } = await wire()
    // Registered first, so this peer picks the handler up from the server's map during
    // accept() rather than having it pushed later. That path has its own attach ordering.
    const seen: ServerPeer<AppMap>[] = []
    server.handle('whoAmI', async (_p, ctx) => {
      seen.push(ctx.peer)
      return { id: ctx.peer.id, origin: ctx.peer.origin }
    })

    const a = await connect(server)
    await a.call('whoAmI', null)

    expect(seen).toHaveLength(1)
    expect(seen[0]?.id).toBeDefined()
    expect(typeof seen[0]?.join).toBe('function')

    a.disconnect()
  })
})
