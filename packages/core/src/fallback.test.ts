/**
 * The contract gate at runtime (D121), and the client and server halves of `withFallback`.
 *
 * The compiler is the first line; `fallback.test-d.ts` holds that. This file is the second:
 * a JavaScript caller with no compiler meets the same refusal from the session, before frame
 * 0, on both sides. And the orchestration: the native connector first every time, the
 * fallback when the runtime has no WebTransport or the WebTransport handshake failed and the
 * WebSocket connects (D125), and a snapshot that says which.
 */
import { describe, expect, test } from 'bun:test'
import { Client, withFallback } from './client.ts'
import {
  buildEventTable,
  defineContract,
  type MapOf,
  reliable,
  rpc,
  unreliable,
} from './contract.ts'
import { TransportError, type TransportErrorCode } from './errors.ts'
import { CloseCode } from './protocol.ts'
import { type ConnectionSource, createServer, type ServerPeer } from './server.ts'
import { Session } from './session.ts'
import { loopbackPair } from './transport/loopback.ts'
import type { Connection } from './transport/types.ts'

const undeclared = defineContract({
  chat: reliable<{ body: string }>(),
  cursor: unreliable<{ x: number; y: number }>(),
})
interface UndeclaredMap extends MapOf<typeof undeclared> {}

const declared = defineContract({
  chat: reliable<{ body: string }>(),
  cursor: unreliable<{ x: number; y: number }>({ fallback: 'newest' }),
  save: rpc<{ text: string }, { n: number }>(),
})
interface DeclaredMap extends MapOf<typeof declared> {}

const failing =
  (code: TransportErrorCode): (() => Promise<Connection>) =>
  () =>
    Promise.reject(new TransportError(code, 'stub', 'stub'))

const oneOf = (conn: Connection): ConnectionSource => ({
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

// norm: fallback-refused-unless-declared
describe('the runtime half of the gate: a session refuses before frame 0', () => {
  test('a websocket pair with an undeclared unreliable event is refused on both sides', async () => {
    const table = await buildEventTable(undeclared)
    const [a, b] = loopbackPair(1024, 'websocket')
    const sa = new Session(a, { table, origin: 1 })
    const sb = new Session(b, { table, origin: 2 })
    const [ea, eb] = await Promise.all([failed(sa.start()), failed(sb.start())])
    expect(ea.code).toBe('WT_RELIABILITY_REFUSED')
    expect(eb.code).toBe('WT_RELIABILITY_REFUSED')
    expect(ea.message).toContain("'cursor'")
    expect(ea.remedy).toContain("fallback: 'newest'")
    expect((await a.closed).code).toBe(CloseCode.WT_RELIABILITY_REFUSED)
  })

  test('the same pair completes its handshake once every unreliable event declares one', async () => {
    const table = await buildEventTable(declared)
    const [a, b] = loopbackPair(1024, 'websocket')
    const sa = new Session(a, { table, origin: 1 })
    const sb = new Session(b, { table, origin: 2 })
    await Promise.all([sa.start(), sb.start()])
    sa.dispose()
    sb.dispose()
  })

  test('a webtransport pair never consults the declarations', async () => {
    const table = await buildEventTable(undeclared)
    const [a, b] = loopbackPair()
    const sa = new Session(a, { table, origin: 1 })
    const sb = new Session(b, { table, origin: 2 })
    await Promise.all([sa.start(), sb.start()])
    sa.dispose()
    sb.dispose()
  })
})

describe('withFallback on the client', () => {
  async function serve(
    conn: Connection,
  ): Promise<ReturnType<typeof createServer<DeclaredMap>>> {
    const server = createServer<DeclaredMap>({ contract: declared })
    await server.listen()
    server.handle('save', async ({ text }) => ({ n: text.length }))
    void server.accept(conn).catch(() => undefined)
    return server
  }

  test('no WebTransport in the runtime: the fallback carries the session, and the snapshot says why', async () => {
    const [serverSide, clientSide] = loopbackPair(1024, 'websocket')
    await serve(serverSide)
    const client = withFallback<DeclaredMap>({
      contract: declared,
      connect: failing('WT_NO_SUPPORT'),
      fallback: async () => clientSide,
    })
    expect(client.getSnapshot().transport).toBeNull()
    await client.connect()
    const s = client.getSnapshot()
    expect(s.status).toBe('connected')
    expect(s.transport).toBe('websocket')
    expect(s.fallbackReason).toBe('unsupported')
    expect(client.native).toBeNull()
    client.disconnect()
    expect(client.getSnapshot().transport).toBeNull()
    expect(client.getSnapshot().fallbackReason).toBeNull()
  })

  test('a server that answers over HTTPS and not over QUIC: the reason is unreachable', async () => {
    const [serverSide, clientSide] = loopbackPair(1024, 'websocket')
    await serve(serverSide)
    const client = withFallback<DeclaredMap>({
      contract: declared,
      connect: failing('WT_UDP_UNREACHABLE'),
      fallback: async () => clientSide,
    })
    await client.connect()
    expect(client.getSnapshot().fallbackReason).toBe('unreachable')
    client.disconnect()
  })

  test('a failed WebTransport handshake dials the fallback, and a WebSocket that connects carries the session as unreachable', async () => {
    const [serverSide, clientSide] = loopbackPair(1024, 'websocket')
    await serve(serverSide)
    let asked = 0
    const client = withFallback<DeclaredMap>({
      contract: declared,
      // What a UDP-only WebTransport port produces: the probe at its origin is unanswered.
      connect: failing('WT_HANDSHAKE_FAILED'),
      fallback: async () => {
        asked++
        return clientSide
      },
    })
    await client.connect()
    expect(asked).toBe(1)
    const s = client.getSnapshot()
    expect(s.status).toBe('connected')
    expect(s.transport).toBe('websocket')
    expect(s.fallbackReason).toBe('unreachable')
    expect(s.lastError).toBeNull()
    client.disconnect()
  })

  test('a failed WebTransport handshake whose fallback fails too throws the WebTransport error', async () => {
    let asked = 0
    const client = withFallback<DeclaredMap>({
      contract: declared,
      connect: failing('WT_HANDSHAKE_FAILED'),
      fallback: async () => {
        asked++
        throw new TransportError('WT_SESSION_CLOSED', 'the socket closed', 'stub')
      },
    })
    const err = await failed(client.connect())
    expect(asked).toBe(1)
    expect(err.code).toBe('WT_HANDSHAKE_FAILED')
    expect(client.getSnapshot().lastError?.code).toBe('WT_HANDSHAKE_FAILED')
  })

  /**
   * The signal, not the mechanism. Safari establishes a WebTransport session and then never
   * sends, because the server never credits it; no Safari runs here, so what is reproduced
   * is what the client can see of that: a transport that connected, then silence before the
   * application handshake. Nothing else in the library produces that (D128).
   */
  test('a transport that connected and then went silent before the handshake falls back: the signal reproduced, not Safari', async () => {
    // Nobody serves the native side, so its handshake never arrives.
    const [, silentNative] = loopbackPair()
    const [serverSide, clientSide] = loopbackPair(1024, 'websocket')
    await serve(serverSide)
    let asked = 0
    const client = withFallback<DeclaredMap>({
      contract: declared,
      handshakeDeadlineMs: 60,
      connect: async () => silentNative,
      fallback: async () => {
        asked++
        return clientSide
      },
    })
    await client.connect()
    expect(asked).toBe(1)
    const s = client.getSnapshot()
    expect(s.status).toBe('connected')
    expect(s.transport).toBe('websocket')
    expect(s.fallbackReason).toBe('unsupported')
    expect(s.lastError).toBeNull()
    // The silent session was closed by its own deadline, with the code that says so.
    expect((await silentNative.closed).code).toBe(CloseCode.WT_HANDSHAKE_TIMEOUT)
    client.disconnect()
  })

  test('silence on the fallback as well throws the WebTransport handshake timeout', async () => {
    const [, silentNative] = loopbackPair()
    const [, silentFallback] = loopbackPair(1024, 'websocket')
    let asked = 0
    const client = withFallback<DeclaredMap>({
      contract: declared,
      handshakeDeadlineMs: 60,
      connect: async () => silentNative,
      fallback: async () => {
        asked++
        return silentFallback
      },
    })
    const err = await failed(client.connect())
    expect(asked).toBe(1)
    expect(err.code).toBe('WT_HANDSHAKE_TIMEOUT')
    expect(client.getSnapshot().status).toBe('closed')
    expect(client.getSnapshot().lastError?.code).toBe('WT_HANDSHAKE_TIMEOUT')
  })

  test('the silence trigger is WebTransport-specific: a silent native connection of another kind is thrown as it is', async () => {
    const [, silentNative] = loopbackPair(1024, 'websocket')
    let asked = 0
    const client = withFallback<DeclaredMap>({
      contract: declared,
      handshakeDeadlineMs: 60,
      connect: async () => silentNative,
      fallback: async () => {
        asked++
        return loopbackPair(1024, 'websocket')[1]
      },
    })
    const err = await failed(client.connect())
    expect(err.code).toBe('WT_HANDSHAKE_TIMEOUT')
    expect(asked).toBe(0)
  })

  test('a configuration error is thrown as it is, and the fallback is never asked', async () => {
    let asked = 0
    const client = withFallback<DeclaredMap>({
      contract: declared,
      connect: failing('WT_CERT_EXPIRED'),
      fallback: async () => {
        asked++
        return loopbackPair()[0]
      },
    })
    const err = await failed(client.connect())
    expect(err.code).toBe('WT_CERT_EXPIRED')
    expect(asked).toBe(0)
    expect(client.getSnapshot().lastError?.code).toBe('WT_CERT_EXPIRED')
  })

  test('when the native connector succeeds, native is the client and call() runs through it', async () => {
    const [serverSide, clientSide] = loopbackPair()
    await serve(serverSide)
    const client = withFallback<DeclaredMap>({
      contract: declared,
      connect: async () => clientSide,
      fallback: failing('WT_SESSION_CLOSED'),
    })
    await client.connect()
    const s = client.getSnapshot()
    expect(s.transport).toBe('webtransport')
    expect(s.fallbackReason).toBeNull()
    expect(client.native).not.toBeNull()
    expect(await client.native?.call('save', { text: 'abc' })).toEqual({ n: 3 })
    client.disconnect()
    expect(client.native).toBeNull()
  })

  test('every connect starts from the native connector again', async () => {
    let attempts = 0
    const pairs = [loopbackPair(1024, 'websocket'), loopbackPair()]
    for (const [serverSide] of pairs) await serve(serverSide)
    const client = withFallback<DeclaredMap>({
      contract: declared,
      connect: async () => {
        attempts++
        if (attempts === 1) throw new TransportError('WT_NO_SUPPORT', 'stub', 'stub')
        return pairs[1]?.[1] as Connection
      },
      fallback: async () => pairs[0]?.[1] as Connection,
    })
    await client.connect()
    expect(client.getSnapshot().transport).toBe('websocket')
    client.disconnect()
    await client.connect()
    expect(attempts).toBe(2)
    expect(client.getSnapshot().transport).toBe('webtransport')
    expect(client.getSnapshot().fallbackReason).toBeNull()
    client.disconnect()
  })

  test('a plain client reports its transport as well', async () => {
    const [serverSide, clientSide] = loopbackPair()
    await serve(serverSide)
    const client = new Client<DeclaredMap>({
      contract: declared,
      connect: async () => clientSide,
    })
    expect(client.getSnapshot().transport).toBeNull()
    await client.connect()
    expect(client.getSnapshot().transport).toBe('webtransport')
    expect(client.getSnapshot().fallbackReason).toBeNull()
    client.disconnect()
  })
})

describe('withFallback on the server', () => {
  test('accepts from a second source and marks the peer with its transport', async () => {
    const [serverSide, clientSide] = loopbackPair(1024, 'websocket')
    const server = createServer<DeclaredMap>({ contract: declared })
    await server.listen()
    const peers: ServerPeer<DeclaredMap>[] = []
    server.onSession((peer) => peers.push(peer))
    server.withFallback(oneOf(serverSide))

    const client = withFallback<DeclaredMap>({
      contract: declared,
      connect: failing('WT_NO_SUPPORT'),
      fallback: async () => clientSide,
    })
    await client.connect()
    expect(peers.map((p) => p.transport)).toEqual(['websocket'])
    expect(server.acceptErrors).toBe(0)
    client.disconnect()
  })

  test('refuses an undeclared contract at accept, counts it, and announces no peer', async () => {
    const [serverSide, clientSide] = loopbackPair(1024, 'websocket')
    const server = createServer<UndeclaredMap>({ contract: undeclared })
    await server.listen()
    let announced = 0
    server.onSession(() => announced++)
    const refused: unknown[] = []
    // The types refuse this line; the cast is the JavaScript caller the runtime half exists for.
    server.withFallback(oneOf(serverSide) as never, { onAcceptError: (e) => refused.push(e) })

    const client = new Client<UndeclaredMap>({
      contract: undeclared,
      connect: async () => clientSide,
    })
    const err = await failed(client.connect())
    expect(err.code).toBe('WT_RELIABILITY_REFUSED')
    await new Promise((r) => setTimeout(r, 20))
    expect(server.acceptErrors).toBe(1)
    expect((refused[0] as TransportError).code).toBe('WT_RELIABILITY_REFUSED')
    expect(announced).toBe(0)
  })

  test('withFallback before listen() is a programming error, not a silent loop', () => {
    const server = createServer<DeclaredMap>({ contract: declared })
    expect(() => server.withFallback(oneOf(loopbackPair()[0]))).toThrow(/listen\(\)/)
  })
})
