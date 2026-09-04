/**
 * A `disconnect` during an in-flight `connect` must abandon the attempt.
 *
 * Found by the React binding's browser test, not here: `connect` awaits the transport, and a
 * `disconnect` arriving during that await used to be ignored, so the session it eventually
 * produced was adopted and had every stored handler registered on it. Two sessions then
 * dispatched to one handler and every event arrived twice.
 *
 * React StrictMode performs exactly this sequence on every mount in development. The
 * loopback transport resolves so fast that the window never opens, which is why a real
 * browser over real QUIC is what surfaced it, and why this test makes the window explicit
 * with a delay rather than hoping to hit it.
 */
import { describe, expect, test } from 'bun:test'
import { Client } from './client.ts'
import { defineContract, type MapOf, reliable } from './contract.ts'
import { createServer } from './server.ts'
import { loopbackPair } from './transport/loopback.ts'
import type { Connection } from './transport/types.ts'

const contract = defineContract({ chat: reliable<{ body: string }>() })
interface AppMap extends MapOf<typeof contract> {}

const settle = async (ms = 150): Promise<void> => {
  await new Promise((r) => setTimeout(r, ms))
}

describe('a connect superseded by a disconnect', () => {
  test('delivers each event once, not once per abandoned session', async () => {
    const server = createServer<AppMap>({ contract })
    await server.listen()
    server.onSession((peer) => {
      void peer.join('r')
      peer.on('chat', (m) => void server.to('r').emit('chat', m))
    })

    // Slow enough that `disconnect` lands while the first connect is still awaiting.
    const connect = async (): Promise<Connection> => {
      const [serverSide, clientSide] = loopbackPair()
      await new Promise((r) => setTimeout(r, 40))
      void server.accept(serverSide).catch(() => undefined)
      return clientSide
    }
    const client = new Client<AppMap>({ contract, connect })

    let delivered = 0
    client.on('chat', () => {
      delivered++
    })

    // The StrictMode shape, with the first attempt still in flight when it is torn down.
    const first = client.connect()
    client.disconnect()
    const second = client.connect()
    await Promise.allSettled([first, second])
    await settle()

    client.emit('chat', { body: 'once' })
    await settle()

    // Two before the fix: the abandoned session was adopted and kept dispatching.
    expect(delivered).toBe(1)
    client.disconnect()
  })

  test('the abandoned session does not stay in the room', async () => {
    const server = createServer<AppMap>({ contract })
    await server.listen()
    server.onSession((peer) => {
      void peer.join('r')
    })

    const connect = async (): Promise<Connection> => {
      const [serverSide, clientSide] = loopbackPair()
      await new Promise((r) => setTimeout(r, 40))
      void server.accept(serverSide).catch(() => undefined)
      return clientSide
    }
    const client = new Client<AppMap>({ contract, connect })

    const first = client.connect()
    client.disconnect()
    const second = client.connect()
    await Promise.allSettled([first, second])
    await settle(300)

    // The superseded session is closed rather than left holding membership.
    expect(server.memberCount('r')).toBe(1)
    client.disconnect()
  })
})
