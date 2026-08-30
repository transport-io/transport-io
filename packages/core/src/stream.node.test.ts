/**
 * `stream()` over real QUIC, because the loopback transport cannot fail the way the wire
 * does. Runs under Node: it loads the native addon (D14).
 *
 * The three things here are the three that were documented and false the last time this
 * project shipped a cancellation story (D69), and each is exercised *mid production*
 * rather than at the start, because a reset arriving before the first frame takes a
 * different path from one arriving during the twenty-fifth.
 *
 * One listener for the whole file. Starting and stopping the native listener per test
 * segfaults the process on the third stop, which reports as a passing suite inside a
 * failing file - a shape this project has been bitten by before.
 *
 * Proves these normative statements, which name this file back:
 *
 *   stream-abort-reaches-responder-over-quic
 *   stream-error-reaches-consumer-over-quic
 *   stream-credit-bounds-the-producer-over-quic
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
import { TransportError } from './errors.ts'
import { STREAM_INITIAL_CREDIT } from './protocol.ts'
import { createServer } from './server.ts'
import { connectHttp3, type Http3Listener, listenHttp3 } from './transport/fails.node.ts'

const contract = defineContract({
  ask: { lane: 'reliable', payload: type$<{ prompt: string }>(), yields: type$<string>() },
})
interface AppMap extends MapOf<typeof contract> {}

const PORT = 34473
let dir: string
let certHash: Uint8Array
let listener: Http3Listener

/** Per-scenario counters, read by the assertions after the client has finished. */
const state = {
  cleanedUp: false,
  produced: 0,
  consumed: 0,
  peakAhead: 0,
}

before(async () => {
  dir = mkdtempSync(join(tmpdir(), 'transport-io-stream-'))
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
  certHash = createHash('sha256').update(new X509Certificate(cert).raw).digest()

  const server = createServer<AppMap>({ contract })
  await server.listen()
  server.handle('ask', async function* ({ prompt }) {
    if (prompt === 'throw') {
      for (let i = 0; i < 10; i++) {
        state.produced++
        yield `token-${i}`
      }
      throw new Error('the model fell over')
    }
    try {
      for (let i = 0; ; i++) {
        state.produced++
        state.peakAhead = Math.max(state.peakAhead, state.produced - state.consumed)
        yield `token-${i}`
      }
    } finally {
      state.cleanedUp = true
    }
  })

  listener = await listenHttp3({ port: PORT, host: '127.0.0.1', cert, privKey, path: '/' })
  const accepting = (async () => {
    for await (const conn of listener.sessions()) void server.accept(conn)
  })()
  void accepting.catch(() => undefined)
})

after(() => {
  listener?.stop()
  rmSync(dir, { recursive: true, force: true })
})

function reset(): void {
  state.cleanedUp = false
  state.produced = 0
  state.consumed = 0
  state.peakAhead = 0
}

async function connected(): Promise<Client<AppMap>> {
  const client = new Client<AppMap>({
    contract,
    connect: () =>
      connectHttp3({ url: `https://127.0.0.1:${PORT}/`, certificateHash: certHash }),
  })
  await client.connect()
  return client
}

async function until(cond: () => boolean, ms = 3000): Promise<void> {
  const deadline = Date.now() + ms
  while (!cond() && Date.now() < deadline) await new Promise((r) => setTimeout(r, 5))
}

test('breaking mid production resets the stream and runs the handler finally', async () => {
  reset()
  const client = await connected()

  const seen: string[] = []
  for await (const token of client.stream('ask', { prompt: 'forever' })) {
    seen.push(token)
    state.consumed++
    if (seen.length === 25) break
  }

  assert.equal(seen.length, 25)
  assert.equal(seen[24], 'token-24')
  await until(() => state.cleanedUp)
  assert.equal(state.cleanedUp, true, "the handler's finally must run when the consumer breaks")
  client.disconnect()
})

test('a handler throwing mid production reaches the consumer as a typed error', async () => {
  reset()
  const client = await connected()

  const seen: string[] = []
  let caught: unknown
  try {
    for await (const token of client.stream('ask', { prompt: 'throw' })) {
      seen.push(token)
      state.consumed++
    }
  } catch (e) {
    caught = e
  }

  // Everything before the throw was delivered and stays delivered. You cannot un-yield.
  assert.equal(seen.length, 10)
  assert.ok(caught instanceof TransportError)
  assert.equal((caught as TransportError).code, 'WT_HANDLER_ERROR')
  assert.match((caught as TransportError).message, /the model fell over/)
  client.disconnect()
})

test('credit bounds how far the producer runs ahead of a slow consumer', async () => {
  reset()
  const client = await connected()

  for await (const _ of client.stream('ask', { prompt: 'forever' })) {
    state.consumed++
    await new Promise((r) => setTimeout(r, 10))
    if (state.consumed >= 20) break
  }

  // THIS is the gate for the credit scheme, and it is here rather than over the loopback
  // transport deliberately: the loopback applies backpressure of its own, so the same
  // assertion there passes with the credit window widened to ten million. It only fails
  // where the lie is, which is the binding whose `writer.ready` resolves unconditionally.
  // Verified in that direction: widen the window and this test, alone, goes red.
  //
  // Absolute, not `STREAM_INITIAL_CREDIT + 1`: a ceiling expressed in terms of the constant
  // under test cannot fail when that constant moves (D13).
  assert.equal(STREAM_INITIAL_CREDIT, 32, 'the window moved; update the ceiling deliberately')
  assert.ok(
    state.peakAhead <= 33,
    `producer ran ${state.peakAhead} ahead of a consumer that took 20; the window is 32`,
  )
  assert.ok(state.produced < 200, `produced ${state.produced} for 20 consumed`)
  client.disconnect()
})

test('a reset discards what the producer had queued, over real QUIC', async () => {
  reset()
  const client = await connected()

  const s = client.stream('ask', { prompt: 'forever' })
  const seen: string[] = []

  // Consumed slowly on purpose. With a consumer that keeps up there is nothing queued at
  // the moment of the reset, and every assertion below holds for the wrong reason.
  const consuming = (async () => {
    for await (const t of s) {
      seen.push(t)
      state.consumed++
      await new Promise((r) => setTimeout(r, 8))
    }
  })().catch(() => undefined)

  await until(() => state.consumed >= 15, 5000)
  const producedAtCancel = state.produced
  const takenAtCancel = seen.length
  s.cancel()
  await consuming
  // Long enough for anything still in flight to have arrived, if it were going to.
  await new Promise((r) => setTimeout(r, 300))

  // The guard that stops this passing over an empty queue. Measured at 18 with the window
  // at 32; ten leaves room without letting the vacuous case through.
  assert.ok(
    producedAtCancel - takenAtCancel >= 10,
    `only ${producedAtCancel - takenAtCancel} frame(s) were queued, so this proves nothing`,
  )
  assert.equal(seen.length, takenAtCancel, 'a queued frame was delivered after the reset')
  assert.equal(state.produced, producedAtCancel, 'the responder kept producing after the reset')
  client.disconnect()
})

test('cancel() stops a stream from outside the loop, over real QUIC', async () => {
  reset()
  const client = await connected()

  const s = client.stream('ask', { prompt: 'forever' })
  const seen: string[] = []

  // The stop button: nothing is inside the loop to `break`, so cancellation has to come
  // from the handle. On the loopback transport a pending read is not unblocked by
  // cancelling the reader, so this behaviour is only meaningful over a real one.
  const consuming = s.forEach((t) => {
    seen.push(t)
    state.consumed++
  })
  await new Promise((r) => setTimeout(r, 60))
  s.cancel()

  const err = await consuming.then(
    () => null,
    (e: unknown) => e,
  )
  assert.ok(err instanceof TransportError, 'cancelling aborts the consumer')
  assert.equal((err as TransportError).code, 'WT_ABORTED')
  assert.ok(seen.length > 0, 'elements arrived before the cancel')

  await until(() => state.cleanedUp)
  assert.equal(state.cleanedUp, true, "the handler's finally must run on cancel()")
  client.disconnect()
})
