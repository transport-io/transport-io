/**
 * What `client.observe()` costs per frame, over the loopback transport, where a frame costs
 * the least and so an observer shows the most.
 *
 * Three modes: nobody observing, an observer writing each record into a ring of 1,000, which
 * is what a panel's store does, and the same with previews on. One mode per process, because
 * a JIT that has seen an observer is not the one a production client runs.
 *
 *   node packages/core/src/bench/observe-cost.node.ts <rest|observe|preview> <reliable|unreliable> <out|in>
 *
 * `out` is the client emitting and the server's handler counting. `in` is the reverse. The
 * run-to-run spread of this bench is about 2%, and the observer's cost is inside it: D149 has
 * the interleaved runs, and the record path measured alone.
 */
import { Client } from '../client.ts'
import { defineContract, type MapOf, type$ } from '../contract.ts'
import { createServer } from '../server.ts'
import { loopbackPair } from '../transport/loopback.ts'

const [mode = 'rest', lane = 'unreliable', dir = 'out'] = process.argv.slice(2)

const contract = defineContract({
  cursor: { lane: 'unreliable', payload: type$<{ from: string; x: number; y: number }>() },
  chat: { lane: 'reliable', payload: type$<{ from: string; body: string; at: number }>() },
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
let seen = 0
if (mode !== 'rest') {
  client.observe(
    (record) => {
      ring[at] = record
      at = at + 1 === RING ? 0 : at + 1
      seen++
    },
    { preview: mode === 'preview' },
  )
}

let received = 0
const count = (): void => {
  received++
}
const send: () => void =
  lane === 'reliable'
    ? ((): (() => void) => {
        const payload = {
          from: 'ada',
          body: 'a message of an ordinary length, as typed',
          at: 0,
        }
        if (dir === 'out') peer.on('chat', count)
        else client.on('chat', count)
        return dir === 'out'
          ? () => client.emit('chat', payload)
          : () => peer.emit('chat', payload)
      })()
    : ((): (() => void) => {
        const payload = { from: 'ada', x: 512, y: 384 }
        if (dir === 'out') peer.on('cursor', count)
        else client.on('cursor', count)
        return dir === 'out'
          ? () => client.emit('cursor', payload)
          : () => peer.emit('cursor', payload)
      })()

// Under both queue bounds, 256 frames and 64 datagrams, so nothing is dropped or refused.
const BATCH = 48
async function run(frames: number): Promise<number> {
  received = 0
  let sent = 0
  const started = process.hrtime.bigint()
  while (sent < frames) {
    for (let i = 0; i < BATCH; i++) send()
    sent += BATCH
    while (received < sent) await new Promise<void>((r) => setImmediate(r))
  }
  return Number(process.hrtime.bigint() - started) / sent
}

await run(48_000) // warm-up, discarded
const samples: number[] = []
for (let i = 0; i < 5; i++) samples.push(await run(96_000))
samples.sort((a, b) => a - b)
console.log(
  `${mode} ${lane} ${dir}: ${Math.round(samples[2] as number)} ns per frame, median of 5` +
    (mode === 'rest' ? '' : `, ${seen.toLocaleString()} records`),
)
process.exit(0)
