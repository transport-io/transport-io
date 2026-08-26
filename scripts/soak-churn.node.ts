/**
 * The axis nothing had ever measured: session churn.
 *
 * `soak.node.ts` opens 500 sessions, holds them for an hour and closes none, so it measures
 * what a *live* session costs over time. Every per-disconnect defect is invisible to it by
 * construction — three were found by inspection, and the reason none of them showed up in a
 * green soak is that no session in that soak ever disconnects.
 *
 * This one connects and disconnects, and measures what a *dead* session leaves behind.
 *
 * It runs over the in-memory loopback transport, deliberately. D65 established that the
 * reference binding leaks ~5.95 KB per bidirectional stream upstream; measuring session
 * churn across it would report that leak plus ours, indistinguishably, and the question
 * here is only ever "do WE leak". Loopback costs 0.045 KB per call, so anything this finds
 * is ours.
 *
 * The bound is retained bytes per session churned — an absolute quantity, and a quantity
 * this library counts. Not a percentage of a baseline measured at run time: that is the
 * defect D13 was written to fix, and it would have certified the exact leak it existed to
 * catch.
 *
 *   node --expose-gc scripts/soak-churn.node.ts [--warmup-seconds 130] [--cycles 12000]
 */
import { Client } from '../packages/core/src/client.ts'
import { defineContract, type MapOf, type$ } from '../packages/core/src/contract.ts'
import { createServer } from '../packages/core/src/server.ts'
import { loopbackPair } from '../packages/core/src/transport/loopback.ts'

const arg = (name: string, fallback: number): number => {
  const i = process.argv.indexOf(`--${name}`)
  const v = i > 0 ? Number(process.argv[i + 1]) : Number.NaN
  return Number.isFinite(v) ? v : fallback
}

/** Cycles in the measured phase, after warmup. */
const CYCLES = arg('cycles', 12000)
/**
 * Warmup is in SECONDS, not cycles, and that is the point. `ORIGIN_QUARANTINE_MS` is
 * 120_000: a freed origin is deliberately held for two minutes before reuse, so a run
 * shorter than that measures quarantine occupancy as though it were a leak. 12,000 cycles
 * take about 17 seconds on this machine, so a cycle-count warmup cannot express "past the
 * window" at all — only wall clock can.
 */
const WARMUP_SECONDS = arg('warmup-seconds', 130)
const SAMPLE_EVERY = arg('sample-every', 500)

/**
 * Measured, not assumed. Without the group-3 fixes this run reports **15,011 B per
 * session** — a leaked `setInterval` holding the entire object graph, which is 5.1 GB an
 * hour at 100 sessions a second.
 *
 * The bound is not tighter because a few hundred bytes of allocator noise per session is
 * not distinguishable from zero at this sample size, and claiming otherwise would make the
 * soak flaky rather than strict.
 */
const BOUND_BYTES_PER_SESSION = arg('bytes-per-session', 2048)

const contract = defineContract({
  chat: { lane: 'stream', payload: type$<{ body: string }>() },
  cursor: { lane: 'datagram', payload: type$<{ x: number; y: number }>() },
  save: { lane: 'stream', payload: type$<{ text: string }>(), returns: type$<{ n: number }>() },
})
interface AppMap extends MapOf<typeof contract> {}

const server = createServer<AppMap>({ contract })
await server.listen()
server.handle('save', async ({ text }) => ({ n: text.length }))

/** One full life: connect, join, use every lane, disconnect. */
async function cycle(i: number): Promise<void> {
  const [serverSide, clientSide] = loopbackPair()
  const client = new Client<AppMap>({ contract, connect: async () => clientSide })
  const [peer] = await Promise.all([server.accept(serverSide), client.connect()])

  client.on('chat', () => {})
  await peer.join('lobby')
  await peer.join(`room-${i % 8}`)
  client.emit('chat', { body: 'x' })
  client.emit('cursor', { x: i, y: i })
  await client.call('save', { text: 'hello' })

  client.disconnect()
  // Teardown is a `conn.closed` continuation on both sides; give it a turn to run.
  await new Promise((r) => setTimeout(r, 0))
}

interface Sample {
  readonly cycles: number
  readonly heapBytes: number
}

const started = Date.now()
const samples: Sample[] = []

function heapAfterGc(): number {
  global.gc?.()
  global.gc?.() // a second pass collects what the first made unreachable
  return process.memoryUsage().heapUsed
}

/** Least-squares slope, in bytes retained per session. Two point samples are not a slope. */
function slopeBytesPerSession(pts: readonly Sample[]): number {
  const n = pts.length
  if (n < 3) return Number.NaN
  const mx = pts.reduce((a, p) => a + p.cycles, 0) / n
  const my = pts.reduce((a, p) => a + p.heapBytes, 0) / n
  const num = pts.reduce((a, p) => a + (p.cycles - mx) * (p.heapBytes - my), 0)
  const den = pts.reduce((a, p) => a + (p.cycles - mx) ** 2, 0)
  return den === 0 ? Number.NaN : num / den
}

const elapsed = (): number => (Date.now() - started) / 1000
const line = (i: number, heap: number, note: string): void => {
  console.log(
    `  ${String(i).padStart(7)} cycles  ${String(Math.round(elapsed())).padStart(4)}s` +
      `   heap ${(heap / 1048576).toFixed(1).padStart(7)} MB${note}`,
  )
}

console.log(`session churn over loopback`)
console.log(
  `warmup ${WARMUP_SECONDS}s (past ORIGIN_QUARANTINE_MS), then ${CYCLES} measured cycles\n`,
)

let n = 0
while (elapsed() < WARMUP_SECONDS) {
  n++
  await cycle(n)
  if (n % (SAMPLE_EVERY * 8) === 0) line(n, heapAfterGc(), '   (warmup, not counted)')
}
const measureFrom = n
line(n, heapAfterGc(), '   <- quarantine at steady state, sampling starts')

for (let i = 1; i <= CYCLES; i++) {
  n++
  await cycle(n)
  if (i % SAMPLE_EVERY === 0) {
    const heap = heapAfterGc()
    samples.push({ cycles: n, heapBytes: heap })
    line(n, heap, '')
  }
}

const slope = slopeBytesPerSession(samples)
const ok = Number.isFinite(slope) && slope < BOUND_BYTES_PER_SESSION

console.log(
  `\nsamples: ${samples.length}, over cycles ${measureFrom}-${n} in ${Math.round(elapsed())}s total`,
)
console.log(
  `retained per session (linear fit)   ${slope >= 0 ? '+' : ''}${slope.toFixed(0)} B` +
    `   bound < ${BOUND_BYTES_PER_SESSION} B   ${ok ? 'PASS' : 'FAIL'}`,
)
console.log(
  `\nprojection at 100 sessions/second: ${((slope * 100 * 3600) / 1048576).toFixed(1)} MB/hour`,
)
console.log(ok ? '\nCHURN SOAK PASSED' : '\nCHURN SOAK FAILED')
process.exit(ok ? 0 : 1)
