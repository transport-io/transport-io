/**
 * What a full ring of 1,000 keeps alive after 5,000 inbound frames of 64 KiB each.
 *
 * This library has had two retention bugs, and a panel holding frames is the obvious third.
 * The last two modes are what a panel does without `observe()`, and the last of them looks
 * like a preview and is not one: a sliced string keeps its whole parent alive.
 *
 *   node --expose-gc packages/core/src/bench/observe-retention.node.ts <none|record|values|slice>
 *
 *   none    nobody observes: the floor.
 *   record  client.observe() with previews on, every record kept in the ring.
 *   values  client.on(), keeping each decoded payload.
 *   slice   client.on(), keeping JSON.stringify(payload).slice(0, 256).
 *
 * Measured 2026-09-17, heap after GC against before the run: none -3.7 MB, record -3.3 MB,
 * values +62.9 MB, slice +62.9 MB. See D149.
 */
import { Client } from '../client.ts'
import { defineContract, type MapOf, type$ } from '../contract.ts'
import { createServer } from '../server.ts'
import { loopbackPair } from '../transport/loopback.ts'

const mode = process.argv[2] ?? 'record'

const contract = defineContract({
  chat: { lane: 'reliable', payload: type$<{ body: string }>() },
})
interface BenchMap extends MapOf<typeof contract> {}

const server = createServer<BenchMap>({ contract })
await server.listen()
const [serverSide, clientSide] = loopbackPair()
const client = new Client<BenchMap>({ contract, connect: async () => clientSide })
const [peer] = await Promise.all([server.accept(serverSide), client.connect()])

const RING = 1000
const ring: unknown[] = new Array(RING).fill(null)
let at = 0
const keep = (x: unknown): void => {
  ring[at] = x
  at = at + 1 === RING ? 0 : at + 1
}

let received = 0
client.on('chat', (p) => {
  received++
  if (mode === 'values') keep(p)
  if (mode === 'slice') keep(JSON.stringify(p).slice(0, 256))
})
if (mode === 'record') client.observe(keep, { preview: true })

const collect = (globalThis as { gc?: () => void }).gc
if (collect === undefined) throw new Error('run with --expose-gc, or the numbers mean nothing')
const settle = async (): Promise<void> => {
  for (let i = 0; i < 5; i++) await new Promise<void>((r) => setImmediate(r))
  collect()
  await new Promise<void>((r) => setImmediate(r))
  collect()
}

await settle()
const before = process.memoryUsage()

const FRAMES = 5000
const BATCH = 40
let sent = 0
while (sent < FRAMES) {
  for (let i = 0; i < BATCH; i++) {
    // A fresh body each time, so nothing is shared between frames and every copy counts.
    peer.emit('chat', {
      body: String(sent + i)
        .padStart(8, '0')
        .repeat(8192),
    })
  }
  sent += BATCH
  while (received < sent) await new Promise<void>((r) => setImmediate(r))
}

await settle()
const after = process.memoryUsage()
const mb = (n: number): string => `${n >= 0 ? '+' : ''}${(n / 1024 / 1024).toFixed(1)} MB`
console.log(
  `${mode}: heap ${mb(after.heapUsed - before.heapUsed)}, ` +
    `array buffers ${mb(after.arrayBuffers - before.arrayBuffers)}, ` +
    `${ring.filter((x) => x !== null).length} kept, ${received} frames`,
)
process.exit(0)
