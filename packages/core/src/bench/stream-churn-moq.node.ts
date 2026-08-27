/**
 * The same per-stream churn probe (D65), against the alternative transport.
 *
 * Identical counts and identical measurement to `stream-churn.node.ts`, so the numbers
 * are comparable. That file measures the reference binding at ~11.76 KB per bidirectional
 * stream; this one measures `@moq/web-transport`, a NAPI-RS binding over a Rust QUIC
 * stack, so the seam in ADR 0007 has a number rather than a hope.
 *
 *   node --expose-gc packages/core/src/bench/stream-churn-moq.node.ts [--rounds 16000]
 */
import { execFileSync } from 'node:child_process'
import { createHash, X509Certificate } from 'node:crypto'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/**
 * Loaded through `napi.cjs` rather than the package entry point, deliberately.
 *
 * `@moq/web-transport` declares `exports: { ".": "./src/index.ts" }` - raw TypeScript,
 * no compiled JavaScript - and Node refuses to strip types inside `node_modules`, so
 * `import ... from '@moq/web-transport'` fails outright with
 * ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING. The native binding underneath is a normal
 * CommonJS module, which is what this measures and what an adapter would bind to.
 */
const nativeRequire = createRequire(import.meta.url)
// By file path: the `exports` map exposes only ".", so even the subpath is unreachable.
const napi = nativeRequire(join(process.cwd(), 'node_modules/@moq/web-transport/napi.cjs')) as {
  NapiClient: {
    withCertificateHashes: (h: Buffer[]) => {
      connect: (url: string) => Promise<MoqSession>
    }
  }
  NapiServer: {
    bind: (
      addr: string,
      cert: Buffer,
      key: Buffer,
    ) => {
      accept: () => Promise<{ ok: () => Promise<MoqSession> } | null>
      close: () => void
    }
  }
}
interface MoqStream {
  takeSend: () => { write: (b: Buffer) => Promise<void>; finish: () => Promise<void> }
  takeRecv: () => { read: (n: number) => Promise<Buffer | null> }
}
interface MoqSession {
  openBi: () => Promise<MoqStream>
  acceptBi: () => Promise<MoqStream>
  close: (code: number, reason: string) => void
}
const { NapiClient, NapiServer } = napi

const argOf = (name: string, fallback: string): string => {
  const i = process.argv.indexOf(`--${name}`)
  return i > 0 ? (process.argv[i + 1] ?? fallback) : fallback
}
const ROUNDS = Number(argOf('rounds', '16000'))
const PORT = Number(argOf('port', '34560'))

const dir = mkdtempSync(join(tmpdir(), 'moq-'))
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
const certPem = readFileSync(join(dir, 'c.pem'))
const keyPem = readFileSync(join(dir, 'k.pem'))
const hash = createHash('sha256').update(new X509Certificate(certPem.toString()).raw).digest()

const mb = (n: number): string => (n / 1048576).toFixed(1)

const server = NapiServer.bind(`127.0.0.1:${PORT}`, certPem, keyPem)

// Echo side: accept a session, then accept bidi streams, drain, reply, finish.
void (async () => {
  const request = await server.accept()
  if (request === null) return
  const session = await request.ok()
  for (;;) {
    const bi = await session.acceptBi()
    const recv = bi.takeRecv()
    const send = bi.takeSend()
    for (;;) {
      const chunk = await recv.read(4096)
      if (chunk === null) break // FIN
    }
    await send.write(Buffer.from([1]))
    await send.finish()
  }
})().catch(() => undefined)

const client = NapiClient.withCertificateHashes([hash])
const session = await client.connect(`https://127.0.0.1:${PORT}/`)

global.gc?.()
const base = process.memoryUsage()
console.log(`@moq/web-transport bidi churn, base heap ${mb(base.heapUsed)} rss ${mb(base.rss)}`)

for (let i = 1; i <= ROUNDS; i++) {
  const bi = await session.openBi()
  const send = bi.takeSend()
  const recv = bi.takeRecv()
  await send.write(Buffer.from([1]))
  await send.finish() // half-close: FIN, read side stays open
  for (;;) {
    const chunk = await recv.read(4096)
    if (chunk === null) break
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
const perStream = (end.heapUsed - base.heapUsed) / ROUNDS / 1024
console.log(`delta heap ${mb(end.heapUsed - base.heapUsed)} MB over ${ROUNDS} streams`)
console.log(`  = ${perStream.toFixed(2)} KB per stream   (reference binding: 11.60)`)

session.close(0, 'done')
server.close()
rmSync(dir, { recursive: true, force: true })
process.exit(0)
