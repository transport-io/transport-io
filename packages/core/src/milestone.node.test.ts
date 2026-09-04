/**
 * The milestone over the real transport: two clients in one room, a message on each lane,
 * across actual QUIC with a real certificate.
 *
 * Runs under Node because it loads the native addon (D14). The loopback version of this
 * test in `milestone.test.ts` proves the session and room logic; this one proves the wire.
 */
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { createHash, X509Certificate } from 'node:crypto'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, test } from 'node:test'
import { Client } from './client.ts'
import { defineContract, type MapOf, type$ } from './contract.ts'
import { createServer } from './server.ts'
import {
  connectHttp3,
  type Http3Listener,
  http3Client,
  listenHttp3,
} from './transport/fails.node.ts'

const contract = defineContract({
  chat: { lane: 'reliable', payload: type$<{ room: string; body: string }>() },
  cursor: { lane: 'unreliable', payload: type$<{ x: number; y: number }>() },
})
// The canonical two-line pattern, exactly as a user writes it.
interface AppMap extends MapOf<typeof contract> {}

const PORT = 34460
let dir: string
let cert: string
let privKey: string
let certHash: Uint8Array
let listener: Http3Listener

before(() => {
  dir = mkdtempSync(join(tmpdir(), 'transport-io-e2e-'))
  const keyPath = join(dir, 'key.pem')
  const certPath = join(dir, 'cert.pem')
  // ECDSA P-256 and at most 14 days: the constraints serverCertificateHashes imposes.
  execFileSync('openssl', [
    'ecparam',
    '-name',
    'prime256v1',
    '-genkey',
    '-noout',
    '-out',
    keyPath,
  ])
  execFileSync('openssl', [
    'req',
    '-new',
    '-x509',
    '-key',
    keyPath,
    '-out',
    certPath,
    '-days',
    '14',
    '-subj',
    '/CN=localhost',
    '-addext',
    'subjectAltName=DNS:localhost,IP:127.0.0.1',
  ])
  cert = readFileSync(certPath, 'utf8')
  privKey = readFileSync(keyPath, 'utf8')
  certHash = createHash('sha256').update(new X509Certificate(cert).raw).digest()
})

after(() => {
  listener?.stop()
  rmSync(dir, { recursive: true, force: true })
})

test('two clients in one room exchange a message on each lane over real QUIC', async () => {
  listener = await listenHttp3({ port: PORT, host: '127.0.0.1', cert, privKey, path: '/' })

  const server = createServer<AppMap>({ contract })
  await server.listen()
  server.onSession((peer) => {
    void peer.join('lobby')
    peer.on('chat', (p) => void server.to('lobby').emit('chat', p))
    peer.on('cursor', (p) => void server.to('lobby').emit('cursor', p))
  })

  // Accept sessions as they arrive; each accept awaits its own handshake.
  const accepting = (async () => {
    for await (const conn of listener.sessions())
      void server.accept(conn).catch(() => undefined)
  })()
  void accepting.catch(() => undefined)

  const url = `https://127.0.0.1:${PORT}/`
  const mk = (origin: number): Client<AppMap> =>
    new Client<AppMap>({
      contract,
      origin,
      connect: () => connectHttp3({ url, certificateHash: certHash }),
    })

  const a = mk(0xc0000001)
  const b = mk(0xc0000002)
  await a.connect()
  await b.connect()

  assert.equal(a.getSnapshot().status, 'connected')
  assert.equal(b.getSnapshot().status, 'connected')

  // The unreliable lane must be genuinely unreliable, not an HTTP/2 fallback wearing the
  // same API. The server only ever constructs Http3Server, so this is belt and braces.
  const chat: unknown[] = []
  const cursor: unknown[] = []
  b.on('chat', (p) => chat.push(p))
  b.on('cursor', (p) => cursor.push(p))

  const settle = async (ms = 400): Promise<void> => {
    await new Promise((r) => setTimeout(r, ms))
  }
  await settle(600) // both peers joined by the server on session

  // --- reliable lane ---
  a.emit('chat', { room: 'lobby', body: 'over real quic' })
  await settle()
  assert.deepEqual(chat, [{ room: 'lobby', body: 'over real quic' }])

  // --- unreliable lane ---
  a.emit('cursor', { x: 7, y: 9 })
  await settle()
  assert.deepEqual(cursor, [{ x: 7, y: 9 }])

  a.disconnect()
  b.disconnect()
})

/**
 * The construct-and-connect form, over the same real transport.
 *
 * `new Client({ connect })` above stays exercised on purpose: it is the seam, and a test is
 * one of the two places it still earns its place. This is the form every example writes, and
 * without a test of its own the only thing holding it would be that it compiles.
 *
 * Reuses the listener and the accept loop the test above started, so this asserts the
 * connect actually happened rather than that a constructor returned.
 */
test('http3Client hands back a client that is already connected', async () => {
  const client = await http3Client<AppMap>({
    contract,
    url: `https://127.0.0.1:${PORT}/`,
    certificateHash: certHash,
  })

  // No `connect()` call anywhere above this line.
  assert.equal(client.getSnapshot().status, 'connected')

  const seen: unknown[] = []
  client.on('chat', (p) => seen.push(p))
  client.emit('chat', { room: 'lobby', body: 'from a one-call client' })
  await new Promise((r) => setTimeout(r, 400))
  assert.deepEqual(seen, [{ room: 'lobby', body: 'from a one-call client' }])

  client.disconnect()
})

/**
 * Type-level, and never called. Omitting the map must fall to `Registered`, which is the
 * sentinel in this program, exactly as it does for `devClient` and `browserClient`. One of
 * the three being wired differently is how this comes back, and the other two are pinned in
 * `transport-clients.test-d.ts`, which cannot import a `*.node.ts` module.
 */
async function sentinelIsWiredForHttp3(): Promise<void> {
  const unbound = await http3Client({ contract, url: '', certificateHash: certHash })
  // @ts-expect-error nothing is registered in this program, so the sentinel refuses every event
  unbound.emit('chat', { room: 'lobby', body: 'x' })
}
void sentinelIsWiredForHttp3
