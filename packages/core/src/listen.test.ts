/**
 * `listen()` owning the accept loop.
 *
 * Ten copies of `for await (const conn of listener.sessions()) void server.accept(conn)`
 * existed across this repository alone, every one of them swallowing the rejection. The
 * loop is now the library's, and the rejection is counted rather than discarded: a failed
 * handshake must not take the server down, and it must not be undiscoverable either.
 */
import { describe, expect, test } from 'bun:test'
import { defineContract, type MapOf, reliable } from './contract.ts'
import { createServer } from './server.ts'
import { loopbackPair } from './transport/loopback.ts'
import type { Connection } from './transport/types.ts'

const contract = defineContract({ chat: reliable<{ body: string }>() })
interface AppMap extends MapOf<typeof contract> {}

/** A source of connections, which is all `listen()` needs of a transport listener. */
function sourceOf(conns: readonly Connection[]): { sessions(): AsyncIterable<Connection> } {
  return {
    async *sessions(): AsyncIterable<Connection> {
      for (const c of conns) yield c
    },
  }
}

const settle = async (): Promise<void> => {
  for (let i = 0; i < 20; i++) await new Promise((r) => setTimeout(r, 1))
}

describe('listen(source) accepts every connection', () => {
  test('a peer that connects through the loop is a session, with no loop in user code', async () => {
    const server = createServer<AppMap>({ contract })
    const [serverSide, clientSide] = loopbackPair()

    let joined = 0
    server.onSession(() => {
      joined++
    })
    await server.listen(sourceOf([serverSide]))

    // The client half still has to complete its own handshake for the session to exist.
    const { Client } = await import('./client.ts')
    const client = new Client<AppMap>({ contract, connect: async () => clientSide })
    await client.connect()
    await settle()

    expect(joined).toBe(1)
    expect(server.acceptErrors).toBe(0)
    client.disconnect()
  })

  test('listen() with no source still works, for anyone driving accept() themselves', async () => {
    const server = createServer<AppMap>({ contract })
    await server.listen()
    const [serverSide, clientSide] = loopbackPair()
    const { Client } = await import('./client.ts')
    const client = new Client<AppMap>({ contract, connect: async () => clientSide })
    await Promise.all([server.accept(serverSide), client.connect()])
    expect(server.acceptErrors).toBe(0)
    client.disconnect()
  })
})

describe('a failed accept is counted, not swallowed and not fatal', () => {
  test('one bad connection does not stop the loop, and the count is observable', async () => {
    const server = createServer<AppMap>({ contract })

    // A connection whose handshake cannot complete: opening the emit stream rejects.
    const broken: Connection = {
      openEmitStream: () => Promise.reject(new Error('no stream for you')),
      onEmitStream: () => {},
      openBidi: () => Promise.reject(new Error('nope')),
      onBidi: () => {},
      sendDatagram: () => {},
      onDatagram: () => {},
      maxDatagramSize: () => 1024,
      close: () => {},
      closed: new Promise(() => {}),
    } as unknown as Connection

    const [serverSide, clientSide] = loopbackPair()
    let joined = 0
    server.onSession(() => {
      joined++
    })

    // Broken first, so the good one only arrives if the loop survived the failure.
    await server.listen(sourceOf([broken, serverSide]))

    const { Client } = await import('./client.ts')
    const client = new Client<AppMap>({ contract, connect: async () => clientSide })
    await client.connect()
    await settle()

    expect(server.acceptErrors).toBe(1)
    expect(joined).toBe(1)
    client.disconnect()
  })

  test('onAcceptError sees the failure when an application wants to act on it', async () => {
    const server = createServer<AppMap>({ contract })
    const seen: unknown[] = []

    const broken: Connection = {
      openEmitStream: () => Promise.reject(new Error('handshake refused')),
      onEmitStream: () => {},
      openBidi: () => Promise.reject(new Error('nope')),
      onBidi: () => {},
      sendDatagram: () => {},
      onDatagram: () => {},
      maxDatagramSize: () => 1024,
      close: () => {},
      closed: new Promise(() => {}),
    } as unknown as Connection

    await server.listen(sourceOf([broken]), {
      onAcceptError: (e) => {
        seen.push(e)
      },
    })
    await settle()

    expect(seen).toHaveLength(1)
    expect((seen[0] as Error).message).toContain('handshake refused')
    // The counter moves whether or not a handler is installed.
    expect(server.acceptErrors).toBe(1)
  })
})
