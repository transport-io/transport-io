/**
 * What the credit window costs and what it buys, per transport.
 *
 * Two questions this answers, both of which were open when the window was first chosen:
 *
 *   1. Is 32 the right size? A smaller window holds less memory per stream, and 256
 *      concurrent streams makes that matter. A larger one waits for credit less often. The
 *      bound and the throughput are measured together so the trade is visible rather than
 *      asserted.
 *   2. Does the transport apply any backpressure of its own? Run with the window widened
 *      past anything a run can spend and the credit scheme stops participating, so whatever
 *      is left is the transport's.
 *
 * The window itself is a compile-time constant, so a sweep patches `protocol.ts` between
 * runs rather than passing a flag. That is deliberate: a runtime knob for a flow-control
 * constant is a knob somebody eventually turns in production.
 *
 *   node packages/core/src/bench/stream-credit-window.node.ts [--transport fails|moq]
 */
import { execFileSync } from 'node:child_process'
import { createHash, X509Certificate } from 'node:crypto'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Client } from '../client.ts'
import { defineContract, type MapOf, type$ } from '../contract.ts'
import { STREAM_CREDIT_REFILL, STREAM_INITIAL_CREDIT } from '../protocol.ts'
import { createServer } from '../server.ts'
import { connectHttp3, listenHttp3 } from '../transport/fails.node.ts'
import { connectMoq, listenMoq } from '../transport/moq.node.ts'
import type { Connection } from '../transport/types.ts'

const which = process.argv.includes('--transport')
  ? (process.argv[process.argv.indexOf('--transport') + 1] ?? 'fails')
  : 'fails'
const PORT = which === 'moq' ? 34486 : 34485

const contract = defineContract({
  ask: { lane: 'reliable', payload: type$<{ n: number }>(), yields: type$<string>() },
})
interface AppMap extends MapOf<typeof contract> {}

const dir = mkdtempSync(join(tmpdir(), 'transport-io-window-'))
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
server.handle('ask', async function* () {
  for (;;) {
    produced++
    peakAhead = Math.max(peakAhead, produced - consumed)
    yield 'token-of-a-realistic-size-for-a-language-model'
  }
})

const listener =
  which === 'moq'
    ? await listenMoq({ port: PORT, host: '127.0.0.1', cert, privKey })
    : await listenHttp3({ port: PORT, host: '127.0.0.1', cert, privKey, path: '/' })
const accepting = (async () => {
  for await (const conn of listener.sessions()) void server.accept(conn).catch(() => undefined)
})()
void accepting.catch(() => undefined)

const url = `https://127.0.0.1:${PORT}/`
const connect = (): Promise<Connection> =>
  which === 'moq'
    ? connectMoq({ url, certificateHash: certHash })
    : connectHttp3({ url, certificateHash: certHash })

const client = new Client<AppMap>({ contract, connect })
await client.connect()

const reset = (): void => {
  produced = 0
  consumed = 0
  peakAhead = 0
}

/** Peak of (produced - consumed) against a consumer that sleeps. */
async function bound(take: number, delayMs: number): Promise<number> {
  reset()
  for await (const _ of client.stream('ask', { n: 0 })) {
    consumed++
    await new Promise((r) => setTimeout(r, delayMs))
    if (consumed >= take) break
  }
  await new Promise((r) => setTimeout(r, 150))
  return peakAhead
}

/** Elements per second with a consumer that never waits: what a small window costs. */
async function throughput(take: number): Promise<number> {
  reset()
  const started = process.hrtime.bigint()
  for await (const _ of client.stream('ask', { n: 0 })) {
    consumed++
    if (consumed >= take) break
  }
  const seconds = Number(process.hrtime.bigint() - started) / 1e9
  await new Promise((r) => setTimeout(r, 150))
  return Math.round(take / seconds)
}

console.log(
  `transport: ${which}   window: ${STREAM_INITIAL_CREDIT}   refill: ${STREAM_CREDIT_REFILL}`,
)
const b20 = await bound(20, 20)
const b40 = await bound(40, 20)
const rate = await throughput(3000)
console.log(
  `  bound  take 20 -> ${String(b20).padStart(8)}   take 40 -> ${String(b40).padStart(8)}` +
    `   ${b40 <= b20 * 1.5 ? 'PLATEAU' : 'GROWING'}`,
)
console.log(
  `  rate   ${rate.toLocaleString()} elements/second with a consumer that never waits`,
)

client.disconnect()
// Not `listener.stop()` on moq: `NapiServer.close()` never returns while an `accept()` is
// outstanding, and the sessions loop always has one. That is D71, and it is why the moq
// parity test is skipped rather than why this bench would be.
if (which !== 'moq') listener.stop()
rmSync(dir, { recursive: true, force: true })
process.exit(0)
