/**
 * The per-stream leak (D65), measured on each side separately.
 *
 * The single-process bench conflates two populations. In production the client is a
 * browser using its own native WebTransport and never touches this binding - the binding
 * runs on the server. So which half leaks decides whether this is a Stage 1 blocker or a
 * documented caveat for Node clients.
 *
 * One process per role, each reporting only its own RSS and heap.
 *
 *   node --expose-gc .../stream-churn-split.node.ts --role server --port 34540
 *   node --expose-gc .../stream-churn-split.node.ts --role client --port 34540 --rounds 8000
 *
 * There is deliberately no transport-io here.
 */
import { execFileSync } from 'node:child_process'
import { createHash, X509Certificate } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { Http3Server, quicheLoaded, WebTransport } from '@fails-components/webtransport'

interface RawStream {
  readable: ReadableStream<Uint8Array>
  writable: WritableStream<Uint8Array>
}
interface RawSession {
  ready: Promise<void>
  incomingBidirectionalStreams: ReadableStream<RawStream>
  createBidirectionalStream: () => Promise<RawStream>
}
interface RawServer {
  startServer: () => void
  stopServer: () => void
  ready: Promise<void>
  sessionStream: (path: string) => ReadableStream<RawSession>
}

const argOf = (name: string, fallback: string): string => {
  const i = process.argv.indexOf(`--${name}`)
  return i > 0 ? (process.argv[i + 1] ?? fallback) : fallback
}

const ROLE = argOf('role', 'server')
const PORT = Number(argOf('port', '34540'))
const ROUNDS = Number(argOf('rounds', '8000'))
const CERT_DIR = argOf('certdir', '/tmp/transport-io-split-cert')

const mb = (n: number): string => (n / 1048576).toFixed(1)

// Both processes need the same certificate, so the server mints it and the client reads it.
function ensureCert(): { cert: string; privKey: string; hash: Buffer } {
  mkdirSync(CERT_DIR, { recursive: true })
  const k = join(CERT_DIR, 'k.pem')
  const c = join(CERT_DIR, 'c.pem')
  if (!existsSync(c)) {
    execFileSync('openssl', ['ecparam', '-name', 'prime256v1', '-genkey', '-noout', '-out', k])
    execFileSync('openssl', [
      'req',
      '-new',
      '-x509',
      '-key',
      k,
      '-out',
      c,
      '-days',
      '14',
      '-subj',
      '/CN=localhost',
      '-addext',
      'subjectAltName=DNS:localhost,IP:127.0.0.1',
    ])
  }
  const cert = readFileSync(c, 'utf8')
  return {
    cert,
    privKey: readFileSync(k, 'utf8'),
    hash: createHash('sha256').update(new X509Certificate(cert).raw).digest(),
  }
}

function report(role: string, n: number, base: NodeJS.MemoryUsage): void {
  global.gc?.()
  const m = process.memoryUsage()
  const perStream = n === 0 ? 0 : (m.heapUsed - base.heapUsed) / n / 1024
  console.log(
    `[${role}] streams ${String(n).padStart(6)}  heap ${mb(m.heapUsed).padStart(7)} MB  ` +
      `rss ${mb(m.rss).padStart(7)} MB  perStream ${perStream.toFixed(2).padStart(7)} KB`,
  )
}

if (ROLE === 'server') {
  const { cert, privKey } = ensureCert()
  const server = new Http3Server({
    port: PORT,
    host: '127.0.0.1',
    secret: 's',
    cert,
    privKey,
  }) as unknown as RawServer
  server.startServer()
  await server.ready
  writeFileSync(join(CERT_DIR, 'ready'), '1')

  let handled = 0
  global.gc?.()
  const base = process.memoryUsage()
  console.log(
    `[server] listening on ${PORT}, base heap ${mb(base.heapUsed)} MB rss ${mb(base.rss)} MB`,
  )

  const reader = server.sessionStream('/').getReader()
  const { value: session } = await reader.read()
  if (session === undefined) process.exit(1)
  await session.ready

  const bidi = session.incomingBidirectionalStreams.getReader()
  for (;;) {
    const { value: st, done } = await bidi.read()
    if (done) break
    if (st === undefined) continue
    const rr = st.readable.getReader()
    for (;;) {
      const r = await rr.read()
      if (r.done) break
    }
    const w = st.writable.getWriter()
    await w.write(new Uint8Array([1]))
    await w.close()
    handled++
    if (handled % 1000 === 0) report('server', handled, base)
    if (handled >= ROUNDS) break
  }
  report('server', handled, base)
  console.log('[server] done')
  server.stopServer()
  process.exit(0)
} else {
  const { hash } = ensureCert()
  await quicheLoaded
  const wt = new WebTransport(`https://127.0.0.1:${PORT}/`, {
    serverCertificateHashes: [{ algorithm: 'sha-256', value: hash }],
  } as never) as unknown as RawSession
  await wt.ready

  global.gc?.()
  const base = process.memoryUsage()
  console.log(`[client] connected, base heap ${mb(base.heapUsed)} MB rss ${mb(base.rss)} MB`)

  for (let i = 1; i <= ROUNDS; i++) {
    const s = await wt.createBidirectionalStream()
    const w = s.writable.getWriter()
    await w.write(new Uint8Array([1]))
    await w.close()
    const rd = s.readable.getReader()
    for (;;) {
      const r = await rd.read()
      if (r.done) break
    }
    if (i % 1000 === 0) report('client', i, base)
  }
  report('client', ROUNDS, base)
  console.log('[client] done')
  process.exit(0)
}
