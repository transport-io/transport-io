/**
 * `stream()`: an async iterable on the client, an async generator on the server.
 *
 * The first test in this file is the one that matters most, and it is first deliberately.
 * D69 exists because four documented guarantees had no code behind them, and three of those
 * had a test whose *name* was the promise while its body asserted something cheaper to
 * reach. The cheap version of "cancellation works" is asserting that the consumer stopped
 * receiving, which is true even when the producer runs for ever. The expensive version, and
 * the only one worth having, is asserting that the handler's own `finally` ran.
 *
 * Proves these normative statements, which name this file back. The link is checked from
 * both ends by `scripts/check-norms.ts`; see D82.
 *
 *   stream-break-closes-generator
 *   stream-empty-terminates-cleanly
 *   stream-error-after-elements
 *   stream-elements-are-frames
 *   stream-not-callable
   stream-producer-bounded-by-credit
   stream-initiator-must-send-credit
   stream-isolated-per-stream
   streaming-initiator-does-not-fin
 */
import { describe, expect, test } from 'bun:test'
import { Client } from './client.ts'
import { encodePayload } from './codec.ts'
import { buildEventTable, defineContract, type MapOf, type$ } from './contract.ts'
import { TransportError } from './errors.ts'
import { encodeFrame, FrameDecoder } from './framer.ts'
import { Codec, FrameType, STREAM_INITIAL_CREDIT } from './protocol.ts'
import { createServer } from './server.ts'
import { loopbackPair } from './transport/loopback.ts'

const contract = defineContract({
  ask: { lane: 'reliable', payload: type$<{ prompt: string }>(), yields: type$<string>() },
  save: {
    lane: 'reliable',
    payload: type$<{ text: string }>(),
    returns: type$<{ n: number }>(),
  },
})
interface AppMap extends MapOf<typeof contract> {}

/** Poll rather than sleep a fixed time: teardown is a continuation, not a timer. */
async function until(cond: () => boolean, ms = 1000): Promise<void> {
  const deadline = Date.now() + ms
  while (!cond() && Date.now() < deadline) await new Promise((r) => setTimeout(r, 2))
}

describe('cancellation reaches the producer', () => {
  test('breaking the loop runs the handler generator finally block', async () => {
    const server = createServer<AppMap>({ contract })
    await server.listen()
    const [serverSide, clientSide] = loopbackPair()
    const client = new Client<AppMap>({ contract, connect: async () => clientSide })

    let cleanedUp = false
    server.handle('ask', async function* () {
      try {
        for (let i = 0; ; i++) yield `token-${i}`
      } finally {
        cleanedUp = true
      }
    })
    await Promise.all([server.accept(serverSide), client.connect()])

    const seen: string[] = []
    for await (const token of client.stream('ask', { prompt: 'x' })) {
      seen.push(token)
      if (seen.length === 3) break
    }

    expect(seen).toEqual(['token-0', 'token-1', 'token-2'])
    await until(() => cleanedUp)
    // The whole point of the generator shape. A callback API has nowhere to put this.
    expect(cleanedUp).toBe(true)
  })
})

describe('termination', () => {
  test('a generator that yields nothing is a clean empty iteration', async () => {
    const server = createServer<AppMap>({ contract })
    await server.listen()
    const [serverSide, clientSide] = loopbackPair()
    const client = new Client<AppMap>({ contract, connect: async () => clientSide })
    // A generator that yields nothing is the case under test, not an oversight.
    // biome-ignore lint/correctness/useYield: the empty sequence is the subject here
    server.handle('ask', async function* () {
      return
    })
    await Promise.all([server.accept(serverSide), client.connect()])

    const seen: string[] = []
    for await (const t of client.stream('ask', { prompt: 'x' })) seen.push(t)
    expect(seen).toEqual([])
    // Same bytes a broken call() responder produces. Only the contract tells them apart,
    // which is why `yields` is declared there and not chosen at the call site.
    expect(await client.stream('ask', { prompt: 'x' }).collect()).toEqual([])
  })

  test('a single yield terminates without a second frame', async () => {
    const server = createServer<AppMap>({ contract })
    await server.listen()
    const [serverSide, clientSide] = loopbackPair()
    const client = new Client<AppMap>({ contract, connect: async () => clientSide })
    server.handle('ask', async function* () {
      yield 'only'
    })
    await Promise.all([server.accept(serverSide), client.connect()])

    expect(await client.stream('ask', { prompt: 'x' }).collect()).toEqual(['only'])
  })

  test('one yield is one CALL_RESPONSE frame, counted on the wire', async () => {
    const server = createServer<AppMap>({ contract })
    await server.listen()
    const [serverSide, clientSide] = loopbackPair()
    const client = new Client<AppMap>({ contract, connect: async () => clientSide })
    server.handle('ask', async function* () {
      yield 'a'
      yield 'b'
      yield 'c'
    })
    await Promise.all([server.accept(serverSide), client.connect()])

    const id = (await buildEventTable(contract)).byName('ask')?.id as number
    const stream = await clientSide.openBidi()
    const writer = stream.writable.getWriter()
    const reader = stream.readable.getReader()
    await writer.write(
      encodeFrame({
        type: FrameType.CALL_REQUEST,
        codec: Codec.JSON,
        eventId: id,
        payload: encodePayload({ prompt: 'x' }),
      }),
    )
    // Deliberately no FIN: a streaming initiator keeps its write side open to carry credit
    // (§6.2), and closing it early means "I will send no more credit", which cancels.
    const decoder = new FrameDecoder()
    const frames: { type: number }[] = []
    for (;;) {
      const { value, done } = await reader.read()
      if (done) break
      if (value !== undefined) frames.push(...decoder.push(value))
    }
    await writer.abort(new Error('done')).catch(() => undefined)
    expect(frames.filter((f) => f.type === FrameType.CALL_RESPONSE).length).toBe(3)
    expect(frames.filter((f) => f.type === FrameType.CALL_ERROR).length).toBe(0)
  })
})

describe('errors mid-stream', () => {
  test('elements yielded before the throw stay delivered, then the loop throws', async () => {
    const server = createServer<AppMap>({ contract })
    await server.listen()
    const [serverSide, clientSide] = loopbackPair()
    const client = new Client<AppMap>({ contract, connect: async () => clientSide })
    server.handle('ask', async function* () {
      yield 'one'
      yield 'two'
      throw new Error('the model fell over')
    })
    await Promise.all([server.accept(serverSide), client.connect()])

    const seen: string[] = []
    const err = await (async () => {
      try {
        for await (const t of client.stream('ask', { prompt: 'x' })) seen.push(t)
        return null
      } catch (e) {
        return e
      }
    })()

    // You cannot un-yield. Two elements were rendered and stay rendered.
    expect(seen).toEqual(['one', 'two'])
    expect(err).toBeInstanceOf(TransportError)
    expect((err as TransportError).code).toBe('WT_HANDLER_ERROR')
    expect((err as TransportError).message).toContain('the model fell over')
  })

  test('collect() rejects rather than resolving with the partial sequence', async () => {
    const server = createServer<AppMap>({ contract })
    await server.listen()
    const [serverSide, clientSide] = loopbackPair()
    const client = new Client<AppMap>({ contract, connect: async () => clientSide })
    server.handle('ask', async function* () {
      yield 'one'
      throw new Error('boom')
    })
    await Promise.all([server.accept(serverSide), client.connect()])

    const err = await client
      .stream('ask', { prompt: 'x' })
      .collect()
      .then(
        () => null,
        (e: unknown) => e,
      )
    // A partial array returned as if it were the whole answer is worse than an error.
    expect(err).toBeInstanceOf(TransportError)
  })

  test('a handler that returns something other than an async iterable is refused', async () => {
    const server = createServer<AppMap>({ contract })
    await server.listen()
    const [serverSide, clientSide] = loopbackPair()
    const client = new Client<AppMap>({ contract, connect: async () => clientSide })
    // The types forbid this; a second implementation, or plain JavaScript, does not.
    server.handle('ask', (() => ({ nope: true })) as never)
    await Promise.all([server.accept(serverSide), client.connect()])

    const err = await client
      .stream('ask', { prompt: 'x' })
      .collect()
      .then(
        () => null,
        (e: unknown) => e,
      )
    expect(err).toBeInstanceOf(TransportError)
    expect((err as TransportError).message).toContain('async iterable')
  })
})

describe('the two methods are disjoint', () => {
  test('call() on a streaming event refuses and names stream()', async () => {
    const server = createServer<AppMap>({ contract })
    await server.listen()
    const [serverSide, clientSide] = loopbackPair()
    const client = new Client<AppMap>({ contract, connect: async () => clientSide })
    await Promise.all([server.accept(serverSide), client.connect()])

    const err = await (client.call as never as (e: string, p: unknown) => Promise<unknown>)(
      'ask',
      { prompt: 'x' },
    ).then(
      () => null,
      (e: unknown) => e,
    )
    expect(err).toBeInstanceOf(TransportError)
    expect((err as TransportError).remedy).toContain('stream()')
  })

  test('stream() on a call event refuses and names call()', async () => {
    const server = createServer<AppMap>({ contract })
    await server.listen()
    const [serverSide, clientSide] = loopbackPair()
    const client = new Client<AppMap>({ contract, connect: async () => clientSide })
    await Promise.all([server.accept(serverSide), client.connect()])

    expect(() =>
      (client.stream as never as (e: string, p: unknown) => unknown)('save', { text: 'x' }),
    ).toThrow(/yields/)
  })
})

describe('cancelling from outside the loop', () => {
  test('an AbortSignal stops the producer and rejects the consumer', async () => {
    const server = createServer<AppMap>({ contract })
    await server.listen()
    const [serverSide, clientSide] = loopbackPair()
    const client = new Client<AppMap>({ contract, connect: async () => clientSide })

    let cleanedUp = false
    server.handle('ask', async function* () {
      try {
        for (let i = 0; ; i++) yield `t-${i}`
      } finally {
        cleanedUp = true
      }
    })
    await Promise.all([server.accept(serverSide), client.connect()])

    const ac = new AbortController()
    const seen: string[] = []
    const err = await (async () => {
      try {
        for await (const t of client.stream('ask', { prompt: 'x' }, { signal: ac.signal })) {
          seen.push(t)
          if (seen.length === 2) ac.abort()
        }
        return null
      } catch (e) {
        return e
      }
    })()

    expect(seen.length).toBeGreaterThanOrEqual(2)
    expect(err).toBeInstanceOf(TransportError)
    expect((err as TransportError).code).toBe('WT_ABORTED')
    await until(() => cleanedUp)
    expect(cleanedUp).toBe(true)
  })
})

describe('backpressure is bounded by something we count', () => {
  test('a slow consumer holds the producer to the credit window', async () => {
    const server = createServer<AppMap>({ contract })
    await server.listen()
    const [serverSide, clientSide] = loopbackPair()
    const client = new Client<AppMap>({ contract, connect: async () => clientSide })

    let produced = 0
    let consumed = 0
    let peakAhead = 0
    server.handle('ask', async function* () {
      for (;;) {
        produced++
        peakAhead = Math.max(peakAhead, produced - consumed)
        yield 'token'
      }
    })
    await Promise.all([server.accept(serverSide), client.connect()])

    for await (const _ of client.stream('ask', { prompt: 'x' })) {
      consumed++
      await new Promise((r) => setTimeout(r, 5))
      if (consumed >= 12) break
    }

    // Not `writer.ready`, which resolves unconditionally on the reference binding and let
    // a producer run 136,523 frames ahead of a consumer that had taken 40. The bound is
    // the credit window, which is a quantity this library counts (D77, D93).
    expect(peakAhead).toBeLessThanOrEqual(STREAM_INITIAL_CREDIT + 1)
    expect(produced).toBeLessThan(200)
  })

  test('a stalled stream does not stall another call on the same session', async () => {
    const server = createServer<AppMap>({ contract })
    await server.listen()
    const [serverSide, clientSide] = loopbackPair()
    const client = new Client<AppMap>({ contract, connect: async () => clientSide })

    server.handle('ask', async function* () {
      for (;;) yield 'token'
    })
    server.handle('save', async ({ text }) => ({ n: text.length }))
    await Promise.all([server.accept(serverSide), client.connect()])

    // Start a stream and take one element, then leave it hanging without breaking. The
    // producer runs out of credit and parks. D2: one stream per call, so this is the
    // peer's problem and nobody else's.
    const stalled = client.stream('ask', { prompt: 'x' })[Symbol.asyncIterator]()
    await stalled.next()

    expect(await client.call('save', { text: 'still works' })).toEqual({ n: 11 })
    await stalled.return?.(undefined)
  })
})

describe('the initiator keeps its send side open', () => {
  test('FIN from the initiator means no more credit, so production stops', async () => {
    const server = createServer<AppMap>({ contract })
    await server.listen()
    const [serverSide, clientSide] = loopbackPair()
    const client = new Client<AppMap>({ contract, connect: async () => clientSide })

    let produced = 0
    let cleanedUp = false
    server.handle('ask', async function* () {
      try {
        for (;;) {
          produced++
          yield 'token'
        }
      } finally {
        cleanedUp = true
      }
    })
    await Promise.all([server.accept(serverSide), client.connect()])

    // Emulate a peer that sends the request and half-closes, as a `returns` initiator
    // would. It can never grant credit, so stalling for ever is the alternative to this
    // rule, and stalling holds a stream slot and a generator open until the session dies.
    const id = (await buildEventTable(contract)).byName('ask')?.id as number
    const stream = await clientSide.openBidi()
    const writer = stream.writable.getWriter()
    await writer.write(
      encodeFrame({
        type: FrameType.CALL_REQUEST,
        codec: Codec.JSON,
        eventId: id,
        payload: encodePayload({ prompt: 'x' }),
      }),
    )
    await writer.close()

    await until(() => cleanedUp)
    expect(cleanedUp).toBe(true)
    // At most the initial window, never the unbounded run a missing credit check allows.
    expect(produced).toBeLessThanOrEqual(STREAM_INITIAL_CREDIT + 1)
  })
})
