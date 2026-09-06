/**
 * Regression measurement for per-stream retention in the reference binding.
 *
 * There is deliberately NO transport-io in this file. It opens a bidirectional stream on
 * the binding, writes, half-closes, reads to end, and repeats. Through 1.6.7 that retained
 * ~11.6 KB per stream, unbounded and linear over 16,000 streams (D65). 1.6.8 fixed it
 * upstream, fails-components/webtransport#511, and the same run measures flat (D119). Our
 * own path over an in-memory transport costs 0.045 KB per call.
 *
 * Run it on every binding upgrade, and when evaluating a transport:
 *
 *   node --expose-gc packages/core/src/bench/stream-churn.node.ts
 *
 * D13 bounds the call() lane at under 1 KB per stream on this measurement. Above it, the
 * retention is back and the exemption that lifted in D119 would have to return with it.
 */
import { execFileSync } from 'node:child_process'
import { createHash, X509Certificate } from 'node:crypto'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Http3Server, WebTransport } from '@fails-components/webtransport'

/** Measured 2026-09-06 on darwin-arm64, Node 22.23.2, binding 1.6.8, over 16,000 streams. */
const OBSERVED_KB_PER_STREAM = -0.21

/** D13's bound for the call() lane. A bound is only a bound if something checks it. */
const BOUND_KB_PER_STREAM = 1

const dir = mkdtempSync(join(tmpdir(), 'bind-'))
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
const cert = readFileSync(join(dir, 'c.pem'), 'utf8'),
  privKey = readFileSync(join(dir, 'k.pem'), 'utf8')
const hash = createHash('sha256').update(new X509Certificate(cert).raw).digest()
const PORT = 34530

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

const server = new Http3Server({
  port: PORT,
  host: '127.0.0.1',
  secret: 's',
  cert,
  privKey,
}) as unknown as RawServer
server.startServer()
await server.ready

void (async () => {
  const r = server.sessionStream('/').getReader()
  const { value: session } = await r.read()
  if (session === undefined) return
  await session.ready
  const bidi = session.incomingBidirectionalStreams.getReader()
  for (;;) {
    const { value: st, done } = await bidi.read()
    if (done) break
    void (async () => {
      const rr = st.readable.getReader()
      for (;;) {
        const { done } = await rr.read()
        if (done) break
      }
      const w = st.writable.getWriter()
      await w.write(new Uint8Array([1]))
      await w.close()
    })().catch(() => undefined)
  }
})()

const wt = new WebTransport(`https://127.0.0.1:${PORT}/`, {
  serverCertificateHashes: [{ algorithm: 'sha-256', value: hash }],
} as never) as unknown as RawSession
await wt.ready

const mb = (n: number) => (n / 1048576).toFixed(1)
const ROUNDS = 16000
global.gc?.()
const base = process.memoryUsage()
console.log(`binding-only bidi churn, base heap ${mb(base.heapUsed)} rss ${mb(base.rss)}`)

for (let i = 1; i <= ROUNDS; i++) {
  const s = await wt.createBidirectionalStream()
  const w = s.writable.getWriter()
  await w.write(new Uint8Array([1]))
  await w.close()
  const rd = s.readable.getReader()
  for (;;) {
    const { done } = await rd.read()
    if (done) break
  }
  if (i % 1000 === 0) {
    global.gc?.()
    const m = process.memoryUsage()
    console.log(
      `  ${String(i).padStart(5)}  heap ${mb(m.heapUsed).padStart(7)}  rss ${mb(m.rss).padStart(7)}`,
    )
  }
}
global.gc?.()
const end = process.memoryUsage()
console.log(`delta heap ${mb(end.heapUsed - base.heapUsed)} MB over ${ROUNDS} streams`)
const perStream = (end.heapUsed - base.heapUsed) / ROUNDS / 1024
console.log(
  `  = ${perStream.toFixed(2)} KB per stream  (last observation ${OBSERVED_KB_PER_STREAM}, bound < ${BOUND_KB_PER_STREAM})`,
)
const ok = perStream < BOUND_KB_PER_STREAM
console.log(
  ok ? '  PASS' : "  FAIL: per-stream retention is back above D13's bound. See D65 and D119.",
)
server.stopServer()
rmSync(dir, { recursive: true, force: true })
process.exit(ok ? 0 : 1)
