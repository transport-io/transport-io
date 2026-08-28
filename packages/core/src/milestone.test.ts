import { describe, expect, test } from 'bun:test'
import { Client } from './client.ts'
import { defineContract, type MapOf, type$ } from './contract.ts'
import { createServer, type ServerPeer } from './server.ts'
import { loopbackPair } from './transport/loopback.ts'

const contract = defineContract({
  chat: { lane: 'reliable', payload: type$<{ room: string; body: string }>() },
  cursor: { lane: 'unreliable', payload: type$<{ x: number; y: number }>() },
})
interface AppMap extends MapOf<typeof contract> {}

const settle = async (): Promise<void> => {
  for (let i = 0; i < 12; i++) await new Promise((r) => setTimeout(r, 1))
}

interface Wired {
  readonly client: Client<AppMap>
  readonly peer: ServerPeer<AppMap>
}

async function connectOne(
  server: ReturnType<typeof createServer<AppMap>>,
  origin: number,
): Promise<Wired> {
  const [serverSide, clientSide] = loopbackPair()
  const client = new Client<AppMap>({ contract, connect: async () => clientSide, origin })
  // accept() and connect() must run concurrently: each awaits the other's handshake.
  const [peer] = await Promise.all([server.accept(serverSide), client.connect()])
  return { client, peer }
}

describe('two clients in one room, a message on each lane', () => {
  test('the milestone', async () => {
    const server = createServer<AppMap>({ contract })
    await server.listen()

    // The server relays whatever a peer sends to everyone in the room.
    server.onSession((peer) => {
      peer.on('chat', (payload) => {
        void server.to('lobby').emit('chat', payload)
      })
      peer.on('cursor', (payload) => {
        void server.to('lobby').emit('cursor', payload)
      })
    })

    const a = await connectOne(server, 0x90000001)
    const b = await connectOne(server, 0x90000002)

    expect(a.client.getSnapshot().status).toBe('connected')
    expect(b.client.getSnapshot().status).toBe('connected')

    const aChat: unknown[] = []
    const bChat: unknown[] = []
    const aCursor: unknown[] = []
    const bCursor: unknown[] = []
    a.client.on('chat', (p) => aChat.push(p))
    b.client.on('chat', (p) => bChat.push(p))
    a.client.on('cursor', (p) => aCursor.push(p))
    b.client.on('cursor', (p) => bCursor.push(p))

    await a.peer.join('lobby')
    await b.peer.join('lobby')
    await settle()

    // Rooms are server-authoritative, and the client learns membership by notification.
    expect(a.client.getSnapshot().rooms).toEqual(['lobby'])
    expect(b.client.getSnapshot().rooms).toEqual(['lobby'])
    expect(server.memberCount('lobby')).toBe(2)

    // --- reliable lane ---
    a.client.emit('chat', { room: 'lobby', body: 'hello from a' })
    await settle()
    expect(aChat).toEqual([{ room: 'lobby', body: 'hello from a' }])
    expect(bChat).toEqual([{ room: 'lobby', body: 'hello from a' }])

    // --- unreliable lane ---
    a.client.emit('cursor', { x: 12, y: 40 })
    await settle()
    expect(aCursor).toEqual([{ x: 12, y: 40 }])
    expect(bCursor).toEqual([{ x: 12, y: 40 }])

    // Both lanes, both clients, one room.
    expect([aChat.length, bChat.length, aCursor.length, bCursor.length]).toEqual([1, 1, 1, 1])
  })

  test('leaving a room stops delivery and updates the snapshot', async () => {
    const server = createServer<AppMap>({ contract })
    await server.listen()
    server.onSession((peer) => {
      peer.on('chat', (p) => void server.to('lobby').emit('chat', p))
    })

    const a = await connectOne(server, 0xa0000001)
    const b = await connectOne(server, 0xa0000002)
    const bGot: unknown[] = []
    b.client.on('chat', (p) => bGot.push(p))

    await a.peer.join('lobby')
    await b.peer.join('lobby')
    await settle()

    a.client.emit('chat', { room: 'lobby', body: 'one' })
    await settle()
    expect(bGot.length).toBe(1)

    await b.peer.leave('lobby')
    await settle()
    expect(b.client.getSnapshot().rooms).toEqual([])
    expect(server.memberCount('lobby')).toBe(1)

    a.client.emit('chat', { room: 'lobby', body: 'two' })
    await settle()
    expect(bGot.length).toBe(1) // still one: b left
  })

  test('except() excludes the sender from its own broadcast', async () => {
    const server = createServer<AppMap>({ contract })
    await server.listen()
    const peers: ServerPeer[] = []
    server.onSession((peer) => {
      peers.push(peer)
      peer.on('chat', (p) => void server.to('lobby').except(peer.id).emit('chat', p))
    })

    const a = await connectOne(server, 0xb0000001)
    const b = await connectOne(server, 0xb0000002)
    const aGot: unknown[] = []
    const bGot: unknown[] = []
    a.client.on('chat', (p) => aGot.push(p))
    b.client.on('chat', (p) => bGot.push(p))

    await a.peer.join('lobby')
    await b.peer.join('lobby')
    await settle()

    a.client.emit('chat', { room: 'lobby', body: 'not to me' })
    await settle()
    expect(aGot).toEqual([])
    expect(bGot.length).toBe(1)
  })

  test('a broadcast to a room with no members is silent, not an error', async () => {
    const server = createServer<AppMap>({ contract })
    await server.listen()
    await expect(
      server.to('empty').emit('chat', { room: 'empty', body: 'x' }),
    ).resolves.toBeUndefined()
  })
})
