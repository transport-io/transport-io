/**
 * Proves these normative statements, which name this file back. The link is checked
 * from both ends by `scripts/check-norms.ts`; see D82.
 *
 *   receiver-accepts-multi-frame-response
 *   host-ordinal-exhaustion-refuses
 *   session-streams-not-reused
 *
 * All three were carrying `UNPROVEN` markers, which is D82's honest-admission escape hatch
 * working as designed and then being taken as an invitation to stop. Each was reachable
 * with a little effort:
 *
 *   - the receiver *does* tolerate a frame sequence, even though no sender produces one, so
 *     the requirement on receivers is testable today by writing the sequence by hand;
 *   - exhaustion needed 4,194,304 allocations, so the allocator grew an injectable counter
 *     space - used here and nowhere else, because an unreachable branch in an allocator is
 *     precisely the code that is wrong the first time it runs;
 *   - "must not reuse a stream from a closed session" needed the implementation to actually
 *     refuse, which it did not.
 */
import { describe, expect, test } from 'bun:test'
import { Client } from './client.ts'
import { encodePayload } from './codec.ts'
import { buildEventTable, defineContract, type MapOf, type$ } from './contract.ts'
import { TransportError } from './errors.ts'
import { encodeFrame, FrameDecoder } from './framer.ts'
import { OriginAllocator } from './origin.ts'
import { Codec, EVENT_ID_NOT_APPLICABLE, FrameType } from './protocol.ts'
import { createServer } from './server.ts'
import { loopbackPair } from './transport/loopback.ts'

const contract = defineContract({
  save: {
    lane: 'reliable',
    payload: type$<{ text: string }>(),
    returns: type$<{ n: number }>(),
  },
})
interface AppMap extends MapOf<typeof contract> {}

describe('§6 - a response is a sequence terminated by stream close', () => {
  test('a receiver accepts more than one CALL_RESPONSE, though no v0 sender sends one', async () => {
    const server = createServer<AppMap>({ contract })
    await server.listen()
    const [serverSide, clientSide] = loopbackPair()
    const client = new Client<AppMap>({ contract, connect: async () => clientSide })
    await Promise.all([server.accept(serverSide), client.connect()])

    // Answer by hand, with a sequence. Nothing in this library produces this shape - D7
    // reserves it for token streaming - so the only way to exercise the receiver's
    // tolerance is to be the sender.
    serverSide.onBidi((stream) => {
      void (async () => {
        const reader = stream.readable.getReader()
        const writer = stream.writable.getWriter()
        for (;;) {
          const { done } = await reader.read()
          if (done) break
        }
        for (const n of [1, 2, 3]) {
          await writer.write(
            encodeFrame({
              type: FrameType.CALL_RESPONSE,
              codec: Codec.JSON,
              eventId: EVENT_ID_NOT_APPLICABLE,
              payload: encodePayload({ n }),
            }),
          )
        }
        await writer.close()
      })()
    })

    // Three frames arrive; the caller resolves on the first and does not fault on the rest.
    expect(await client.call('save', { text: 'x' })).toEqual({ n: 1 })
  })

  test('this implementation, as a sender, emits exactly one', async () => {
    const server = createServer<AppMap>({ contract })
    await server.listen()
    const [serverSide, clientSide] = loopbackPair()
    const client = new Client<AppMap>({ contract, connect: async () => clientSide })
    server.handle('save', async ({ text }) => ({ n: text.length }))
    await Promise.all([server.accept(serverSide), client.connect()])

    const id = (await buildEventTable(contract)).byName('save')?.id as number
    const stream = await clientSide.openBidi()
    const writer = stream.writable.getWriter()
    const reader = stream.readable.getReader()
    await writer.write(
      encodeFrame({
        type: FrameType.CALL_REQUEST,
        codec: Codec.JSON,
        eventId: id,
        payload: encodePayload({ text: 'abcd' }),
      }),
    )
    await writer.close()

    const decoder = new FrameDecoder()
    const frames = []
    for (;;) {
      const { value, done } = await reader.read()
      if (done) break
      if (value !== undefined) frames.push(...decoder.push(value))
    }
    // Exactly one, which is what §6 says a version 0 sender does. A Go implementer reading
    // "sequence" should not build a loop expecting more from this peer.
    expect(frames.filter((f) => f.type === FrameType.CALL_RESPONSE).length).toBe(1)
  })
})

describe('§7.3 - a host that exhausts its origin space refuses new sessions', () => {
  test('allocation throws WT_TOO_MANY_STREAMS rather than reusing or wrapping', () => {
    // Eight values instead of 4,194,304. The branch is identical; only the size differs.
    const alloc = new OriginAllocator(1, 120_000, 8)
    const taken = new Set<number>()
    for (let i = 0; i < 8; i++) taken.add(alloc.allocate(0))
    expect(taken.size).toBe(8) // no duplicates on the way to the limit

    let thrown: unknown
    try {
      alloc.allocate(0)
    } catch (e) {
      thrown = e
    }
    expect(thrown).toBeInstanceOf(TransportError)
    expect((thrown as TransportError).code).toBe('WT_TOO_MANY_STREAMS')
    // The remedy matters: this is a concurrency limit, not a clock, and the operator needs
    // to know that restarting the host will not help.
    expect((thrown as TransportError).remedy).toMatch(/concurrency limit/i)
  })

  test('a freed origin returns to service once its quarantine passes', () => {
    const alloc = new OriginAllocator(1, 1_000, 4)
    const first = alloc.allocate(0)
    for (let i = 0; i < 3; i++) alloc.allocate(0)
    expect(() => alloc.allocate(0)).toThrow()

    alloc.free(first, 0)
    expect(() => alloc.allocate(500)).toThrow() // still quarantined
    expect(alloc.allocate(2_000)).toBe(first) // released, and reused rather than retired
  })
})

describe('§11 - a stream from a closed session is not reused', () => {
  test('call() on a closed session refuses instead of opening a stream', async () => {
    const server = createServer<AppMap>({ contract })
    await server.listen()
    const [serverSide, clientSide] = loopbackPair()
    const client = new Client<AppMap>({ contract, connect: async () => clientSide })
    server.handle('save', async ({ text }) => ({ n: text.length }))
    await Promise.all([server.accept(serverSide), client.connect()])

    expect(await client.call('save', { text: 'ok' })).toEqual({ n: 2 })

    client.disconnect()
    await new Promise((r) => setTimeout(r, 20))

    // The transport may well accept `openBidi()` on a dead session, in which case the call
    // hangs for ever rather than failing - which is why refusing here is the requirement
    // and not merely tidy.
    const err = await client.call('save', { text: 'no' }).then(
      () => null,
      (e: unknown) => e,
    )
    expect(err).toBeInstanceOf(TransportError)
    expect((err as TransportError).code).toBe('WT_SESSION_CLOSED')
  })
})
