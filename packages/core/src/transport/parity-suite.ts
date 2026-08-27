const randomPort = (): number => 40000 + Math.floor(Math.random() * 20000)

/**
 * The parity suite body, shared by one test file per transport.
 *
 * A byte count established that `@moq/web-transport` does not leak (D66). It established
 * nothing else. This establishes the rest: half-close for `call()`, reset for
 * `AbortSignal`, `maxDatagramSize`, oversized-datagram behaviour, and both lanes end to
 * end. The reference binding got each of those wrong in specific ways; this is how we
 * find out which ways the alternative gets them wrong.
 */
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { createHash, X509Certificate } from 'node:crypto'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { Client } from '../client.ts'
import { defineContract, type MapOf, type$ } from '../contract.ts'
import type { TransportError } from '../errors.ts'
import type { Connection } from './types.ts'

const contract = defineContract({
  chat: { lane: 'stream', payload: type$<{ body: string }>() },
  cursor: { lane: 'datagram', payload: type$<{ n: number }>() },
  echo: { lane: 'stream', payload: type$<{ n: number }>(), returns: type$<{ n: number }>() },
  slow: { lane: 'stream', payload: type$<null>(), returns: type$<null>() },
})
interface AppMap extends MapOf<typeof contract> {}

interface Listener {
  port: number
  sessions: () => AsyncIterable<Connection>
  stop: () => void
}
export interface UnderTest {
  /**
   * Whether a peer's stream reset reaches the responder's `ctx.signal`.
   *
   * `false` is a real capability gap. moq surfaces STOP_SENDING only on
   * the next write, and a long-running handler never makes one, so the handler is not
   * told to stop. The caller still rejects either way - the work just keeps running.
   */
  readonly propagatesAbortToHandler: boolean
  readonly name: string
  readonly port: number
  listen: (o: {
    port: number
    host: string
    cert: string
    privKey: string
  }) => Promise<Listener>
  connect: (o: { url: string; certificateHash: Uint8Array }) => Promise<Connection>
}

// Random high ports. A fixed port makes this suite fail for a reason that has nothing to
// do with the code - an orphan from a previous killed run still holding the socket, which
// cost an hour to diagnose once already.

const dir = mkdtempSync(join(tmpdir(), 'parity-'))
execFileSync('openssl', [
  'ecparam',
  '-name',
  'prime256v1',
  '-genkey',
  '-noout',
  '-out',
  join(dir, 'k.pem'),
])
execFileSync('openssl', [
  'req',
  '-new',
  '-x509',
  '-key',
  join(dir, 'k.pem'),
  '-out',
  join(dir, 'c.pem'),
  '-days',
  '14',
  '-subj',
  '/CN=localhost',
  '-addext',
  'subjectAltName=DNS:localhost,IP:127.0.0.1',
])
const cert = readFileSync(join(dir, 'c.pem'), 'utf8')
const privKey = readFileSync(join(dir, 'k.pem'), 'utf8')
const certificateHash = createHash('sha256').update(new X509Certificate(cert).raw).digest()

const settle = async (ms = 400): Promise<void> => {
  await new Promise((r) => setTimeout(r, ms))
}

/**
 * One transport per process, deliberately.
 *
 * Running both bindings' servers concurrently in a single process hangs - verified: each
 * works alone and both can bind, but sessions on both at once deadlock. That is a
 * property of running two native QUIC stacks side by side, not of transport-io, and no
 * deployment would do it. Splitting by process is also better isolation.
 */
export async function runParity(t: UnderTest): Promise<void> {
  const { createServer } = await import('../server.ts')
  const server = createServer<AppMap>({ contract })
  await server.listen()
  server.handle('echo', async ({ n }) => ({ n: n * 2 }))
  let handlerSawAbort = false
  server.handle('slow', async (_p, ctx) => {
    await new Promise<void>((resolve) => {
      ctx.signal.addEventListener(
        'abort',
        () => {
          handlerSawAbort = true
          resolve()
        },
        { once: true },
      )
      // Bounded, so a transport that never delivers the reset fails an assertion instead
      // of hanging the suite. That distinction cost an afternoon to find.
      setTimeout(resolve, 3000)
    })
    return null
  })
  server.onSession((peer) => {
    void peer.join('lobby')
    peer.on('chat', (p) => void server.to('lobby').emit('chat', p))
    peer.on('cursor', (p) => void server.to('lobby').emit('cursor', p))
  })

  const listener = await t.listen({ port: t.port, host: '127.0.0.1', cert, privKey })
  void (async () => {
    for await (const conn of listener.sessions())
      void server.accept(conn).catch(() => undefined)
  })().catch(() => undefined)

  const url = `https://127.0.0.1:${t.port}/`
  const client = new Client<AppMap>({
    contract,
    origin: 0xf0000001,
    connect: () => t.connect({ url, certificateHash }),
  })
  await client.connect()
  assert.equal(client.getSnapshot().status, 'connected', `${t.name}: connected`)

  const chat: string[] = []
  const cursor: number[] = []
  client.on('chat', (p) => chat.push(p.body))
  client.on('cursor', (p) => cursor.push(p.n))
  await settle(600)

  client.emit('chat', { body: 'reliable' })
  await settle()
  assert.deepEqual(chat, ['reliable'], `${t.name}: stream lane`)

  client.emit('cursor', { n: 7 })
  await settle()
  assert.deepEqual(cursor, [7], `${t.name}: datagram lane`)

  // Half-close for the request, response read to stream close.
  assert.deepEqual(await client.call('echo', { n: 21 }), { n: 42 }, `${t.name}: call`)

  // AbortSignal maps to a stream reset. The caller always rejects; whether the reset
  // reaches the responder is a property of the transport, asserted either way so a
  // regression in the supported direction is caught.
  const ac = new AbortController()
  const pending = client.call('slow', null, { signal: ac.signal })
  await settle(150)
  ac.abort()
  await assert.rejects(pending, `${t.name}: abort rejects the caller`)
  await settle(900)
  assert.equal(
    handlerSawAbort,
    t.propagatesAbortToHandler,
    `${t.name}: expected ctx.signal to ${t.propagatesAbortToHandler ? '' : 'NOT '}fire`,
  )

  // Our layer refuses oversize before the transport can silently discard it.
  assert.throws(
    () => client.emit('cursor', { n: 1, pad: 'x'.repeat(4000) } as never),
    (e: unknown) => (e as TransportError).code === 'WT_DATAGRAM_TOO_LARGE',
    `${t.name}: oversized datagram refused locally`,
  )

  client.disconnect()
  listener.stop()
  rmSync(dir, { recursive: true, force: true })
}

export { randomPort }
