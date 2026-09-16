/**
 * Two things an application guessed and the rooms guide now states (D135). Everything this
 * node hands one peer on the reliable lane leaves on that peer's one emit stream in the
 * order it was handed, whichever API handed it: `peer.emit`, a broadcast to a room the peer
 * is in, and the join notification. And handlers attach to the client, not to a session, so
 * one registered before `connect()` receives everything from every session.
 */
import { describe, expect, test } from 'bun:test'
import { Client } from './client.ts'
import { defineContract, type MapOf, reliable } from './contract.ts'
import { createServer } from './server.ts'
import { loopbackPair } from './transport/loopback.ts'

const contract = defineContract({ line: reliable<{ n: number; via: string }>() })
interface AppMap extends MapOf<typeof contract> {}

const wait = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms)
  })

describe("order on one peer's emit stream", () => {
  test('peer.emit before peer.join is delivered before anything the room sends after', async () => {
    const [serverSide, clientSide] = loopbackPair()
    const server = createServer<AppMap>({ contract })
    await server.listen()
    const client = new Client<AppMap>({ contract, connect: async () => clientSide })
    const seen: string[] = []
    client.on('line', ({ n, via }) => seen.push(`${via}:${n}`))
    client.subscribe(() => {
      const { rooms } = client.getSnapshot()
      if (rooms.length > 0 && !seen.includes('joined')) seen.push('joined')
    })
    const [peer] = await Promise.all([server.accept(serverSide), client.connect()])

    // The application's pattern: history by peer.emit, then the room, then live traffic.
    for (let i = 0; i < 5; i++) peer.emit('line', { n: i, via: 'history' })
    await peer.join('board')
    for (let i = 0; i < 5; i++) await server.to('board').emit('line', { n: i, via: 'room' })
    await wait(20)

    expect(seen).toEqual([
      'history:0',
      'history:1',
      'history:2',
      'history:3',
      'history:4',
      'joined',
      'room:0',
      'room:1',
      'room:2',
      'room:3',
      'room:4',
    ])
    client.disconnect()
  })

  test('call order is delivery order, whichever API sends: a broadcast, then peer.emit, then a broadcast', async () => {
    const [serverSide, clientSide] = loopbackPair()
    const server = createServer<AppMap>({ contract })
    await server.listen()
    const client = new Client<AppMap>({ contract, connect: async () => clientSide })
    const seen: string[] = []
    client.on('line', ({ n, via }) => seen.push(`${via}:${n}`))
    const [peer] = await Promise.all([server.accept(serverSide), client.connect()])
    await peer.join('board')

    // Not awaited: local delivery happens before the adapter is consulted.
    void server.to('board').emit('line', { n: 0, via: 'room' })
    peer.emit('line', { n: 1, via: 'direct' })
    void server.to('board').emit('line', { n: 2, via: 'room' })
    await wait(20)
    expect(seen).toEqual(['room:0', 'direct:1', 'room:2'])
    client.disconnect()
  })
})

describe('handlers attach to the client', () => {
  test('a handler registered before connect() receives from the first session and from the next', async () => {
    const server = createServer<AppMap>({ contract })
    await server.listen()
    const connect = async () => {
      const [serverSide, clientSide] = loopbackPair()
      void server.accept(serverSide).then((peer) => peer.emit('line', { n: 1, via: 'hello' }))
      return clientSide
    }
    const client = new Client<AppMap>({ contract, connect })
    const seen: string[] = []
    client.on('line', ({ via }) => seen.push(via))
    await client.connect()
    await wait(20)
    client.disconnect()
    await client.connect()
    await wait(20)
    expect(seen).toEqual(['hello', 'hello'])
    client.disconnect()
  })
})
