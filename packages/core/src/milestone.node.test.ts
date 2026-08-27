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
import { connectHttp3, type Http3Listener, listenHttp3 } from './transport/fails.node.ts'

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
    for await (const conn of listener.sessions()) void server.accept(conn)
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
