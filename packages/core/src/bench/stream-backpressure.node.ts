/**
 * How far ahead of a slow consumer can a streaming handler get?
 *
 * `stream()` was originally designed on the assumption that flow control fell out of the
 * language: the generator does not resume until the write is accepted, so nothing would
 * accumulate. This bench disproved that. `writer.ready` resolves unconditionally on the
 * quiche binding, and the credit window in §6.6 exists because of what this measured.
 *
 * It is kept so the claim can be rechecked against another transport or another release.
 *
 * So this measures `produced - consumed` at its peak, against a consumer that sleeps. Both
 * peers are in this process, so both counters are exact.
 *
 * Two element sizes, because the answer is expected to be a byte budget rather than a frame
 * count: QUIC flow control is measured in bytes, so small elements should get further ahead
 * than large ones. If the peak grows with the run length instead of plateauing, there is no
 * backpressure at all and the design claim is false.
 *
 *   node packages/core/src/bench/stream-backpressure.node.ts
 */
import { execFileSync } from 'node:child_process'
import { createHash, X509Certificate } from 'node:crypto'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Client } from '../client.ts'
import { defineContract, type MapOf, type$ } from '../contract.ts'
import { createServer } from '../server.ts'
import { connectHttp3, type Http3Listener, listenHttp3 } from '../transport/fails.node.ts'

const contract = defineContract({
  ask: { lane: 'reliable', payload: type$<{ size: number }>(), yields: type$<string>() },
})
interface AppMap extends MapOf<typeof contract> {}

const PORT = 34472
const dir = mkdtempSync(join(tmpdir(), 'transport-io-bp-'))
const keyPath = join(dir, 'key.pem')
const certPath = join(dir, 'cert.pem')
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
const cert = readFileSync(certPath, 'utf8')
const privKey = readFileSync(keyPath, 'utf8')
const certHash = createHash('sha256').update(new X509Certificate(cert).raw).digest()

let produced = 0
let consumed = 0
let peakAhead = 0

const server = createServer<AppMap>({ contract })
await server.listen()
server.handle('ask', async function* ({ size }) {
  const element = 'x'.repeat(size)
  for (;;) {
    produced++
    peakAhead = Math.max(peakAhead, produced - consumed)
    yield element
  }
})

const listener: Http3Listener = await listenHttp3({
  port: PORT,
  host: '127.0.0.1',
  cert,
  privKey,
  path: '/',
})
const accepting = (async () => {
  for await (const conn of listener.sessions()) void server.accept(conn)
})()
void accepting.catch(() => undefined)

const client = new Client<AppMap>({
  contract,
  connect: () => connectHttp3({ url: `https://127.0.0.1:${PORT}/`, certificateHash: certHash }),
})
await client.connect()

interface Run {
  readonly size: number
  readonly take: number
  readonly peak: number
  readonly bytes: number
}

async function run(size: number, take: number, delayMs: number): Promise<Run> {
  produced = 0
  consumed = 0
  peakAhead = 0
  for await (const _ of client.stream('ask', { size })) {
    consumed++
    await new Promise((r) => setTimeout(r, delayMs))
    if (consumed >= take) break
  }
  // The generator keeps running for a moment after the reset; let it settle before the
  // next run resets the counters.
  await new Promise((r) => setTimeout(r, 200))
  return { size, take, peak: peakAhead, bytes: peakAhead * (size + 12) }
}

console.log('stream backpressure over real QUIC')
console.log('peak of (produced - consumed), consumer sleeping 20 ms per element\n')

const runs: Run[] = []
for (const size of [16, 1024, 65536]) {
  for (const take of [20, 40]) {
    const r = await run(size, take, 20)
    runs.push(r)
    console.log(
      `  element ${String(size).padStart(6)} B   consumed ${String(take).padStart(3)}` +
        `   peak ahead ${String(r.peak).padStart(6)} frames` +
        `   ~${(r.bytes / 1024).toFixed(0).padStart(6)} KiB in flight`,
    )
  }
}

// Doubling what the consumer takes must not double how far the producer gets ahead. If it
// does, nothing is holding anything and the bound is imaginary.
console.log('')
for (const size of [16, 1024, 65536]) {
  const [a, b] = runs.filter((r) => r.size === size)
  if (a === undefined || b === undefined) continue
  const growth = b.peak / Math.max(a.peak, 1)
  console.log(
    `  ${String(size).padStart(6)} B elements: peak ${a.peak} -> ${b.peak} when the run doubled` +
      `   (${growth.toFixed(2)}x)   ${growth < 1.5 ? 'PLATEAU' : 'GROWING'}`,
  )
}

client.disconnect()
listener.stop()
rmSync(dir, { recursive: true, force: true })
process.exit(0)
