/**
 * The memory soak. Stage 1 graduation criterion D13.
 *
 * D2 opens a bidirectional stream per call, which maximally exercises the upstream path
 * with a known leak (#425: RSS 500M -> 700M+ over 12h at 500 concurrent). This is the one
 * criterion that can still fail, so the number matters more than the run.
 *
 * The threshold is an ABSOLUTE SLOPE BY LINEAR FIT, not two point samples. The original
 * criterion was "5% growth between T+10 and T+60", and against #425's own 16.7 MB/h that
 * yields ~13.9 MB, which at any plausible baseline is under 5% - it would have certified
 * the exact leak it was written to catch. Two point samples are not a slope.
 *
 *   node --expose-gc scripts/soak.node.ts [--minutes 60] [--sessions 500]
 */
import { execFileSync } from 'node:child_process'
import { createHash, X509Certificate } from 'node:crypto'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Client } from '../packages/core/src/client.ts'
import { defineContract, type MapOf, type$ } from '../packages/core/src/contract.ts'
import { createServer } from '../packages/core/src/server.ts'
import { connectHttp3, listenHttp3 } from '../packages/core/src/transport/fails.node.ts'

const argStr = (name: string, fallback: string): string => {
  const i = process.argv.indexOf(`--${name}`)
  return i > 0 ? (process.argv[i + 1] ?? fallback) : fallback
}

const arg = (name: string, fallback: number): number => {
  const i = process.argv.indexOf(`--${name}`)
  return i > 0 ? Number(process.argv[i + 1]) : fallback
}

/**
 * `--lanes emit,unreliable` measures only the lanes bound by D13's slope criterion.
 * `--lanes call` measures the exempted lane, whose number is recorded rather than gated.
 * Default is all three, which will fail until the upstream leak is fixed - that is the
 * exemption being visible rather than silent.
 */
const LANES = argStr('lanes', 'emit,unreliable,call').split(',')
const MINUTES = arg('minutes', 60)
const SESSIONS = arg('sessions', 500)
const PORT = arg('port', 34500)
const WARMUP_MIN = 10
const SAMPLE_EVERY_MIN = 5
const SLOPE_BOUND_MB_PER_H = 4
const RSS_CEILING_MB = 600
const TARGET_CALLS = 50_000

const contract = defineContract({
  ping: { lane: 'reliable', payload: type$<{ n: number }>(), returns: type$<{ n: number }>() },
  tick: { lane: 'unreliable', payload: type$<{ n: number }>() },
  note: { lane: 'reliable', payload: type$<{ n: number }>() },
})
interface SoakMap extends MapOf<typeof contract> {}

const dir = mkdtempSync(join(tmpdir(), 'transport-io-soak-'))
execFileSync('openssl', [
  'ecparam',
  '-name',
  'prime256v1',
  '-genkey',
  '-noout',
  '-out',
  join(dir, 'key.pem'),
])
execFileSync('openssl', [
  'req',
  '-new',
  '-x509',
  '-key',
  join(dir, 'key.pem'),
  '-out',
  join(dir, 'cert.pem'),
  '-days',
  '14',
  '-subj',
  '/CN=localhost',
  '-addext',
  'subjectAltName=DNS:localhost,IP:127.0.0.1',
])
const cert = readFileSync(join(dir, 'cert.pem'), 'utf8')
const privKey = readFileSync(join(dir, 'key.pem'), 'utf8')
const certificateHash = createHash('sha256').update(new X509Certificate(cert).raw).digest()

const server = createServer<SoakMap>({ contract })
await server.listen()
server.handle('ping', async ({ n }) => ({ n }))
server.onSession((peer) => {
  void peer.join('soak')
})

const listener = await listenHttp3({ port: PORT, host: '127.0.0.1', cert, privKey, path: '/' })
void (async () => {
  for await (const conn of listener.sessions()) void server.accept(conn).catch(() => undefined)
})()

console.log(`soak: ${SESSIONS} sessions, ${MINUTES} min, lanes: ${LANES.join(', ')}`)
if (!LANES.includes('call')) {
  console.log('note: the call lane is excluded - this run measures the D13-bound lanes only')
}
console.log(`platform: ${process.platform}-${process.arch}, node ${process.version}`)
console.log('')

const clients: Client<SoakMap>[] = []
for (let i = 0; i < SESSIONS; i++) {
  const c = new Client<SoakMap>({
    contract,
    origin: 0x40000000 + i,
    connect: () => connectHttp3({ url: `https://127.0.0.1:${PORT}/`, certificateHash }),
  })
  try {
    await c.connect()
    clients.push(c)
  } catch (e) {
    console.error(`session ${i} failed: ${(e as Error).message}`)
    break
  }
  if ((i + 1) % 100 === 0) console.log(`  connected ${i + 1}/${SESSIONS}`)
}
console.log(`connected ${clients.length} sessions`)
console.log('')

let calls = 0
let callErrors = 0
let running = true

// Churn call streams: one bidirectional stream opened and closed per call, which is the
// allocation path the leak lives on.
const churn = async (): Promise<void> => {
  while (running) {
    const batch = clients.map(async (c, i) => {
      if (LANES.includes('call')) {
        try {
          await c.call('ping', { n: i })
          calls++
        } catch {
          callErrors++
        }
      }
      if (LANES.includes('unreliable')) c.emit('tick', { n: i })
      if (LANES.includes('emit')) c.emit('note', { n: i })
    })
    await Promise.all(batch)
    await new Promise((r) => setTimeout(r, 5))
  }
}
void churn()

interface Sample {
  readonly minute: number
  readonly rssMb: number
}
const samples: Sample[] = []

const sampleRss = (): number => {
  global.gc?.()
  return process.memoryUsage().rss / 1024 / 1024
}

const started = Date.now()
const elapsedMin = (): number => (Date.now() - started) / 60_000

for (let minute = 0; minute <= MINUTES; minute += SAMPLE_EVERY_MIN) {
  while (elapsedMin() < minute) await new Promise((r) => setTimeout(r, 1000))
  const rssMb = sampleRss()
  const counted = minute >= WARMUP_MIN
  if (counted) samples.push({ minute, rssMb })
  console.log(
    `  t+${String(minute).padStart(2)}min  rss ${rssMb.toFixed(1).padStart(7)} MB  ` +
      `calls ${calls}  errors ${callErrors}${counted ? '' : '  (warmup, excluded)'}`,
  )
}

running = false
await new Promise((r) => setTimeout(r, 500))

/** Least-squares fit. Two point samples are not a slope. */
function slopeMbPerHour(pts: readonly Sample[]): number {
  const n = pts.length
  const meanX = pts.reduce((s, p) => s + p.minute, 0) / n
  const meanY = pts.reduce((s, p) => s + p.rssMb, 0) / n
  const num = pts.reduce((s, p) => s + (p.minute - meanX) * (p.rssMb - meanY), 0)
  const den = pts.reduce((s, p) => s + (p.minute - meanX) ** 2, 0)
  return den === 0 ? 0 : (num / den) * 60
}

/**
 * A fit needs points. Without this the whole criterion inverts on an empty sample set:
 * `den === 0` returns a slope of 0, `Math.max()` of nothing is `-Infinity`, and both
 * comparisons pass - so a run too short to reach the end of its own warmup printed
 * `peak RSS -Infinity MB  bound < 600  PASS` and exited 0.
 *
 * That is the D13 defect one more layer down: a threshold that certifies the absence of
 * measurement. Three points is the minimum a least-squares line means anything over, and it
 * is the same floor the churn soak uses.
 */
const MIN_SAMPLES = 3
const enoughSamples = samples.length >= MIN_SAMPLES

const slope = slopeMbPerHour(samples)
const peak = samples.length === 0 ? Number.NaN : Math.max(...samples.map((s) => s.rssMb))
const slopeOk = enoughSamples && slope < SLOPE_BOUND_MB_PER_H
const ceilingOk = enoughSamples && peak < RSS_CEILING_MB
const callsOk = !LANES.includes('call') || calls >= TARGET_CALLS

console.log('')
console.log('─'.repeat(64))
console.log(`samples (after ${WARMUP_MIN}min warmup): ${samples.length}`)
if (!enoughSamples) {
  console.log(
    `  NOT ENOUGH SAMPLES - need ${MIN_SAMPLES}, got ${samples.length}. ` +
      `Run for longer than the ${WARMUP_MIN}min warmup plus ${MIN_SAMPLES} sample intervals.`,
  )
}
console.log(
  `slope (linear fit)   ${slope >= 0 ? '+' : ''}${slope.toFixed(2)} MB/h   bound < ${SLOPE_BOUND_MB_PER_H}   ${slopeOk ? 'PASS' : 'FAIL'}`,
)
console.log(
  `peak RSS             ${peak.toFixed(1)} MB          bound < ${RSS_CEILING_MB}  ${ceilingOk ? 'PASS' : 'FAIL'}`,
)
console.log(
  `call streams churned ${calls}          target ${TARGET_CALLS}  ${callsOk ? 'PASS' : 'FAIL'}`,
)
console.log(`call errors          ${callErrors}`)
console.log('─'.repeat(64))
console.log(slopeOk && ceilingOk && callsOk ? 'SOAK PASSED' : 'SOAK FAILED')

for (const c of clients) c.disconnect()
listener.stop()
rmSync(dir, { recursive: true, force: true })
process.exit(slopeOk && ceilingOk && callsOk ? 0 : 1)
