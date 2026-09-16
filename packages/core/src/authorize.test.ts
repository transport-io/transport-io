/**
 * The peer's edges: what a listener's `authorize` attached arrives as `peer.data`, a refusal
 * reaches the client as `WT_UNAUTHORIZED` with the server's reason and before any frame the
 * server would have sent, and a departure is visible twice, once while the rooms still say
 * where the peer was and once after they have let go (D130).
 */
import { describe, expect, test } from 'bun:test'
import { Client } from './client.ts'
import { defineContract, type MapOf, reliable, rpc } from './contract.ts'
import type { TransportError } from './errors.ts'
import { CloseCode } from './protocol.ts'
import { type ConnectionSource, createServer, type ServerPeer } from './server.ts'
import { loopbackPair } from './transport/loopback.ts'
import type { CloseInfo, Connection } from './transport/types.ts'

const contract = defineContract({
  chat: reliable<{ body: string }>(),
  whoami: rpc<Record<string, never>, { user: string }>(),
})
interface AppMap extends MapOf<typeof contract> {}
interface Who {
  user: string
}

const withData = (conn: Connection, data: Who): Connection & { readonly data: Who } =>
  Object.assign(conn, { data })

const oneOf = <D>(conn: Connection & { readonly data?: D }): ConnectionSource<D> => ({
  async *sessions() {
    yield conn
  },
})

const failed = (p: Promise<unknown>): Promise<TransportError> =>
  p.then(
    () => {
      throw new Error('expected a rejection')
    },
    (e: unknown) => e as TransportError,
  )

const wait = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms)
  })

describe('peer.data', () => {
  test('is what the connection carried, and a responder reads it from ctx.peer', async () => {
    const [serverSide, clientSide] = loopbackPair()
    const server = createServer<AppMap, Who>({ contract })
    server.handle('whoami', async (_, ctx) => ({ user: ctx.peer.data.user }))
    const seen: Who[] = []
    server.onSession((peer) => seen.push(peer.data))
    await server.listen(oneOf(withData(serverSide, { user: 'ann' })))

    const client = new Client<AppMap>({ contract, connect: async () => clientSide })
    await client.connect()
    expect(await client.call('whoami', {})).toEqual({ user: 'ann' })
    expect(seen).toEqual([{ user: 'ann' }])
    client.disconnect()
  })

  test('is assignable, so a server without authorize can keep state there', async () => {
    const [serverSide, clientSide] = loopbackPair()
    const server = createServer<AppMap, { name?: string }>({ contract })
    await server.listen()
    const client = new Client<AppMap>({ contract, connect: async () => clientSide })
    const [peer] = await Promise.all([server.accept(serverSide), client.connect()])
    expect(peer.data).toBeUndefined()
    peer.data = { name: 'set later' }
    expect(peer.data.name).toBe('set later')
    client.disconnect()
  })
})

describe('a refused peer', () => {
  // norm: unauthorized-closes-before-handshake
  test('sees WT_UNAUTHORIZED with the reason, and never a frame from the server', async () => {
    const [serverSide, clientSide] = loopbackPair()
    let received = 0
    clientSide.onEmitStream((readable) => {
      void (async () => {
        for await (const chunk of readable) received += chunk.byteLength
      })()
    })
    // What a listener does for a null verdict: close before any session exists.
    serverSide.close(CloseCode.WT_UNAUTHORIZED, 'refused by authorize')

    const client = new Client<AppMap>({ contract, connect: async () => clientSide })
    const err = await failed(client.connect())
    expect(err.code).toBe('WT_UNAUTHORIZED')
    expect(err.message).toContain('refused by authorize')
    expect(client.getSnapshot().lastError?.code).toBe('WT_UNAUTHORIZED')
    expect(received).toBe(0)
  })

  test('is not a reason to fall back: the error is thrown as it is', async () => {
    const [serverSide, clientSide] = loopbackPair()
    serverSide.close(CloseCode.WT_UNAUTHORIZED, 'no token')
    let asked = 0
    const { withFallback } = await import('./client.ts')
    const client = withFallback<AppMap>({
      contract,
      connect: async () => clientSide,
      fallback: async () => {
        asked++
        return loopbackPair(1024, 'websocket')[1]
      },
    })
    const err = await failed(client.connect())
    expect(err.code).toBe('WT_UNAUTHORIZED')
    expect(asked).toBe(0)
  })
})

describe('a departing peer', () => {
  test('onDisconnecting still sees its rooms, and closed settles once they are gone', async () => {
    const [serverSide, clientSide] = loopbackPair()
    const server = createServer<AppMap>({ contract })
    await server.listen()
    const client = new Client<AppMap>({ contract, connect: async () => clientSide })
    const [peer] = await Promise.all([server.accept(serverSide), client.connect()])
    await peer.join('lobby')
    expect(server.memberCount('lobby')).toBe(1)

    const order: string[] = []
    let sawRooms: readonly string[] = []
    let sawInfo: CloseInfo | undefined
    server.onDisconnecting((p: ServerPeer<AppMap>, info) => {
      sawRooms = p.rooms
      sawInfo = info
      order.push(`disconnecting members=${server.memberCount('lobby')}`)
    })
    void peer.closed.then(() => order.push(`closed members=${server.memberCount('lobby')}`))

    client.disconnect()
    const info = await peer.closed
    await wait(0)
    expect(sawRooms).toEqual(['lobby'])
    expect(sawInfo?.code).toBe(info.code)
    expect(order).toEqual(['disconnecting members=1', 'closed members=0'])
  })

  test('a server-side close reports the code it chose', async () => {
    const [serverSide, clientSide] = loopbackPair()
    const server = createServer<AppMap>({ contract })
    await server.listen()
    const client = new Client<AppMap>({ contract, connect: async () => clientSide })
    const [peer] = await Promise.all([server.accept(serverSide), client.connect()])
    peer.close(CloseCode.WT_PROTOCOL_ERROR, 'bye')
    const info = await peer.closed
    expect(info).toMatchObject({ code: CloseCode.WT_PROTOCOL_ERROR })
    client.disconnect()
  })
})
