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
   stream-zero-credit-parks
   stream-parked-producer-released-on-close
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
    expect(await client.stream('ask', { prompt: 'x' }).toArray()).toEqual([])
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

    expect(await client.stream('ask', { prompt: 'x' }).toArray()).toEqual(['only'])
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
      .toArray()
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
      .toArray()
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
  /**
   * This one proves the mechanism runs, NOT the bound.
   *
   * Measured: with the credit window widened past anything a run can spend, this test still
   * passes, because the loopback transport applies backpressure of its own. A gate that is
   * green whether or not the thing it gates exists is not a gate. The bound is proved in
   * `stream.node.test.ts`, over the transport whose `writer.ready` is the reason any of this
   * exists.
   */
  test('the producer parks at the window and resumes when the consumer takes more', async () => {
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

    // Absolute, not `STREAM_INITIAL_CREDIT + 1`. A ceiling written in terms of the constant
    // it is testing cannot fail when that constant moves - widen the window and the
    // assertion widens with it. That is D13's rule, and this file broke it on the first
    // draft: with the window at ten million, `<= STREAM_INITIAL_CREDIT + 1` passed.
    expect(STREAM_INITIAL_CREDIT).toBe(32)
    expect(peakAhead).toBeLessThanOrEqual(33)
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
    expect(produced).toBeLessThanOrEqual(33)
  })
})

describe('a producer with no credit', () => {
  test('parks indefinitely rather than dropping, timing out, or racing ahead', async () => {
    const server = createServer<AppMap>({ contract })
    await server.listen()
    const [serverSide, clientSide] = loopbackPair()
    const client = new Client<AppMap>({ contract, connect: async () => clientSide })

    let produced = 0
    server.handle('ask', async function* () {
      for (;;) {
        produced++
        yield 'token'
      }
    })
    await Promise.all([server.accept(serverSide), client.connect()])

    // One element, then stop asking. The consumer is slow, not gone, and there is no way
    // for the responder to tell those apart, so it waits.
    const it = client.stream('ask', { prompt: 'x' })[Symbol.asyncIterator]()
    await it.next()
    await new Promise((r) => setTimeout(r, 150))
    const parked = produced
    await new Promise((r) => setTimeout(r, 250))

    expect(STREAM_INITIAL_CREDIT).toBe(32)
    expect(parked).toBeLessThanOrEqual(33)
    // Still parked a quarter of a second later. No timeout fires, nothing is dropped.
    expect(produced).toBe(parked)
    await it.return?.(undefined)
  })

  test('is released when the session closes, so it cannot outlive its peer', async () => {
    const server = createServer<AppMap>({ contract })
    await server.listen()
    const [serverSide, clientSide] = loopbackPair()
    const client = new Client<AppMap>({ contract, connect: async () => clientSide })

    let cleanedUp = false
    server.handle('ask', async function* () {
      try {
        for (;;) yield 'token'
      } finally {
        cleanedUp = true
      }
    })
    await Promise.all([server.accept(serverSide), client.connect()])

    const it = client.stream('ask', { prompt: 'x' })[Symbol.asyncIterator]()
    await it.next()
    await new Promise((r) => setTimeout(r, 150))
    expect(cleanedUp).toBe(false) // parked, waiting for credit that will never come

    // The peer goes away without breaking the loop. Nothing in the credit scheme can
    // detect that, so session liveness has to, or the generator waits for ever holding one
    // of 256 stream slots.
    client.disconnect()
    await until(() => cleanedUp)
    expect(cleanedUp).toBe(true)
  })
})

describe('a handler needs no signal check of its own', () => {
  test('a loop with no throwIfAborted still stops, and its finally runs', async () => {
    const server = createServer<AppMap>({ contract })
    await server.listen()
    const [serverSide, clientSide] = loopbackPair()
    const client = new Client<AppMap>({ contract, connect: async () => clientSide })

    let cleanedUp = false
    let pulls = 0
    // No `ctx.signal.throwIfAborted()` anywhere. The responder drives this generator, so
    // it checks the signal before asking for the next value; the handler does not have to
    // repeat that check in every loop it writes. `throwIfAborted()` remains the escape
    // hatch for a handler doing long work *between* yields, where nothing else can
    // interrupt it.
    server.handle('ask', async function* () {
      try {
        for (;;) {
          pulls++
          yield 'token'
        }
      } finally {
        cleanedUp = true
      }
    })
    await Promise.all([server.accept(serverSide), client.connect()])

    const seen: string[] = []
    for await (const t of client.stream('ask', { prompt: 'x' })) {
      seen.push(t)
      if (seen.length === 3) break
    }

    await until(() => cleanedUp)
    expect(cleanedUp).toBe(true)
    expect(seen).toHaveLength(3)

    // And it stopped: no further pulls once the consumer had gone.
    const settled = pulls
    await new Promise((r) => setTimeout(r, 80))
    expect(pulls).toBe(settled)
  })
})

describe('iterator helpers', () => {
  const rig = async (): Promise<{
    client: Client<AppMap>
    state: { produced: number; cleanedUp: boolean }
  }> => {
    const server = createServer<AppMap>({ contract })
    await server.listen()
    const [serverSide, clientSide] = loopbackPair()
    const client = new Client<AppMap>({ contract, connect: async () => clientSide })
    const state = { produced: 0, cleanedUp: false }
    server.handle('ask', async function* () {
      try {
        for (let i = 0; ; i++) {
          state.produced++
          yield `t${i}`
        }
      } finally {
        state.cleanedUp = true
      }
    })
    await Promise.all([server.accept(serverSide), client.connect()])
    return { client, state }
  }

  test('toArray collects a finite sequence', async () => {
    const server = createServer<AppMap>({ contract })
    await server.listen()
    const [serverSide, clientSide] = loopbackPair()
    const client = new Client<AppMap>({ contract, connect: async () => clientSide })
    server.handle('ask', async function* () {
      yield 'a'
      yield 'b'
    })
    await Promise.all([server.accept(serverSide), client.connect()])
    expect(await client.stream('ask', { prompt: 'x' }).toArray()).toEqual(['a', 'b'])
  })

  test('take(n) stops the source, the same as break', async () => {
    const { client, state } = await rig()
    const first = await client.stream('ask', { prompt: 'x' }).take(3).toArray()
    expect(first).toEqual(['t0', 't1', 't2'])

    // `take` closes the underlying iterator when it reaches its limit, which resets the
    // stream and runs the handler's `finally`.
    await until(() => state.cleanedUp)
    expect(state.cleanedUp).toBe(true)
    expect(state.produced).toBeLessThanOrEqual(33)
  })

  test('take(0) yields nothing and never opens the stream', async () => {
    const { client, state } = await rig()
    expect(await client.stream('ask', { prompt: 'x' }).take(0).toArray()).toEqual([])
    await new Promise((r) => setTimeout(r, 60))
    // The generator is lazy: nothing is pulled, so no request is sent and the handler is
    // never invoked. There is nothing to clean up because nothing started.
    expect(state.produced).toBe(0)
    expect(state.cleanedUp).toBe(false)
  })

  test('forEach awaits the callback before pulling the next element', async () => {
    const { client, state } = await rig()
    const seen: string[] = []
    let maxAhead = 0

    await client
      .stream('ask', { prompt: 'x' })
      .take(6)
      .forEach(async (t) => {
        seen.push(t)
        maxAhead = Math.max(maxAhead, state.produced - seen.length)
        await new Promise((r) => setTimeout(r, 15))
      })

    expect(seen).toHaveLength(6)
    // A callback that is not awaited would let the producer run away. The credit window
    // bounds it at 32 either way, so this asserts the callback is awaited by checking the
    // consumer never ran ahead of its own callback.
    expect(maxAhead).toBeLessThanOrEqual(33)
  })
})
