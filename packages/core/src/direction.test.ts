/**
 * Direction on an event (D134). The types refuse the wrong sender; this file is the runtime
 * half: a caller with no compiler meets the same refusal at `emit`, and a peer that sends
 * the wrong way anyway is dropped, counted, and never handled. And the honest limit: an
 * undirected event is still one payload shape for both directions.
 */
import { describe, expect, test } from 'bun:test'
import { Client } from './client.ts'
import {
  buildEventTable,
  defineContract,
  fromClient,
  fromServer,
  type MapOf,
  reliable,
  unreliable,
} from './contract.ts'
import type { TransportError } from './errors.ts'
import { createServer } from './server.ts'
import { Session } from './session.ts'
import { loopbackPair } from './transport/loopback.ts'

const contract = defineContract({
  chat: reliable<{ body: string }>(),
  users: fromServer(reliable<{ names: string[] }>()),
  move: fromClient(unreliable<{ x: number }>({ fallback: 'newest' })),
})
interface AppMap extends MapOf<typeof contract> {}

const wait = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms)
  })

async function pair() {
  const [serverSide, clientSide] = loopbackPair()
  const server = createServer<AppMap>({ contract })
  await server.listen()
  const client = new Client<AppMap>({ contract, connect: async () => clientSide })
  const [peer] = await Promise.all([server.accept(serverSide), client.connect()])
  return { server, client, peer }
}

describe('the declared side sends', () => {
  test('the right direction crosses, both ways, and the map carries from', async () => {
    const { server, client, peer } = await pair()
    const atClient: string[][] = []
    const atServer: number[] = []
    client.on('users', ({ names }) => atClient.push(names))
    peer.on('move', ({ x }) => atServer.push(x))
    await peer.join('r')
    peer.emit('users', { names: ['a'] })
    await server.to('r').emit('users', { names: ['b'] })
    client.emit('move', { x: 3 })
    await wait(30)
    expect(atClient).toEqual([['a'], ['b']])
    expect(atServer).toEqual([3])
    expect(contract.users.from).toBe('server')
    expect(contract.move.from).toBe('client')
    expect((contract.chat as { from?: string }).from).toBeUndefined()
    client.disconnect()
  })

  test('a caller with no compiler is refused at emit, on both ends', async () => {
    const { server, client, peer } = await pair()
    const untyped = client as unknown as { emit: (e: string, p: unknown) => void }
    expect(() => untyped.emit('users', { names: [] })).toThrow(/declared from: 'server'/)
    const peerUntyped = peer as unknown as { emit: (e: string, p: unknown) => void }
    expect(() => peerUntyped.emit('move', { x: 1 })).toThrow(/declared from: 'client'/)
    const codes: string[] = []
    try {
      untyped.emit('users', { names: [] })
    } catch (e) {
      codes.push((e as TransportError).code)
    }
    await expect(
      (server.to('r') as unknown as { emit: (e: string, p: unknown) => Promise<void> }).emit(
        'move',
        { x: 1 },
      ),
    ).rejects.toThrow(/a broadcast is the server sending/)
    expect(codes).toEqual(['WT_VALIDATION_FAILED'])
    client.disconnect()
  })

  test('a peer that sends the wrong way anyway is dropped, counted, and never handled', async () => {
    // A raw session with no side, standing in for a second implementation that ignores the
    // direction, against a server that declares `users` as its own.
    const [serverSide, clientSide] = loopbackPair()
    const server = createServer<AppMap>({ contract })
    await server.listen()
    const rogue = new Session(clientSide, { table: await buildEventTable(contract), origin: 9 })
    const [peer] = await Promise.all([server.accept(serverSide), rogue.start()])
    let handled = 0
    peer.on('chat', () => handled++)
    const untypedOn = peer as unknown as { on: (e: string, h: () => void) => void }
    untypedOn.on('users', () => handled++)
    rogue.emit('users', { names: ['x'] })
    rogue.emit('chat', { body: 'still fine' })
    await wait(30)
    expect(handled).toBe(1)
    expect(peer.stats().directionDropped).toBe(1)
    rogue.close(0, 'done')
  })
})
