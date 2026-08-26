/**
 * D1, the first decision this project made: the lane is a property of the message type,
 * never of the call site. A contract that says "may be dropped" must not be able to produce
 * a guaranteed, ordered, acknowledged message.
 *
 * It could. `{ lane: 'datagram', payload, returns }` compiled — excess property checking
 * against a *union* admits any property present on any member — `CallableOf` then admitted
 * the event, and `Session.call` never looked at the lane, so the request went out over a
 * bidirectional stream and came back answered. The type system agreed with the violation
 * the whole way down.
 *
 * The type hole is closed by `returns?: never` on the datagram branch and asserted in
 * `types.test-d.ts`. This file covers the runtime, which matters for a reason the type fix
 * cannot address: a peer is not bound by our types. A Go implementation written from
 * PROTOCOL.md, or any caller reaching the wire directly, can open a bidirectional stream
 * for a datagram event whenever it likes.
 */
/**
 * Proves these normative statements, which name this file back. The link is checked
 * from both ends by `scripts/check-norms.ts`; see D82.
 *
 *   datagram-guarantees-need-stream-lane
 *   lane-lives-in-the-contract
 */
import { describe, expect, test } from 'bun:test'
import { Client } from './client.ts'
import { encodePayload } from './codec.ts'
import { buildEventTable, defineContract, type MapOf, type$ } from './contract.ts'
import { encodeFrame, FrameDecoder } from './framer.ts'
import { Codec, FrameType } from './protocol.ts'
import { createServer } from './server.ts'
import { loopbackPair } from './transport/loopback.ts'

const contract = defineContract({
  chat: { lane: 'stream', payload: type$<{ body: string }>() },
  cursor: { lane: 'datagram', payload: type$<{ x: number; y: number }>() },
  save: { lane: 'stream', payload: type$<{ text: string }>(), returns: type$<{ n: number }>() },
})
interface AppMap extends MapOf<typeof contract> {}

async function wire() {
  const server = createServer<AppMap>({ contract })
  await server.listen()
  const [serverSide, clientSide] = loopbackPair()
  const client = new Client<AppMap>({ contract, connect: async () => clientSide })
  const [peer] = await Promise.all([server.accept(serverSide), client.connect()])
  return { server, client, peer, clientSide }
}

describe('a datagram event is not callable, from either side of the wire', () => {
  test('this side refuses to call a datagram event', async () => {
    const { client } = await wire()
    // The type system now refuses this too; the cast is what a JavaScript consumer, or a
    // consumer one `any` away from the contract, gets for free.
    await expect(client.call('cursor' as never, { x: 1, y: 2 } as never)).rejects.toThrow(
      /datagram/i,
    )
  })

  test('registering a call handler for a datagram event is refused', async () => {
    const { server } = await wire()
    // Without this, the guard on `call()` alone is theatre: the responder half is what
    // actually turns a droppable message into an acknowledged one.
    expect(() => server.handle('cursor' as never, (async () => ({})) as never)).toThrow(
      /datagram/i,
    )
  })

  test('a peer opening a call stream for a datagram event is refused', async () => {
    const { server, clientSide } = await wire()
    // Registered through the back door, the way a JavaScript consumer would. Even with a
    // handler present the responder must refuse, because the lane is the contract.
    try {
      server.handle('cursor' as never, (async () => ({ ok: true })) as never)
    } catch {
      // Refused at registration, which is the stronger outcome. The wire check below still
      // has to hold for a peer that never asked us.
    }
    const id = (await buildEventTable(contract)).byName('cursor')?.id as number

    const stream = await clientSide.openBidi()
    const writer = stream.writable.getWriter()
    const reader = stream.readable.getReader()
    await writer.write(
      encodeFrame({
        type: FrameType.CALL_REQUEST,
        codec: Codec.JSON,
        eventId: id,
        payload: encodePayload({ x: 1, y: 2 }),
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

    // Refused with an error frame, not answered, and not silently dropped either — the
    // caller has to learn that its contract disagrees with ours.
    expect(frames.length).toBeGreaterThan(0)
    expect(frames[0]?.type).toBe(FrameType.CALL_ERROR)
    void server
  })

  test('a stream event without `returns` is still not callable', async () => {
    const { client } = await wire()
    // `chat` is on the stream lane but declares no response. Calling it is a different
    // mistake from calling a datagram event, and must also fail rather than hang.
    await expect(client.call('chat' as never, { body: 'x' } as never)).rejects.toThrow()
  })

  test('the datagram lane still works normally — the guard is not a blanket refusal', async () => {
    const { client, peer } = await wire()
    const seen: unknown[] = []
    client.on('cursor', (p) => seen.push(p))
    peer.emit('cursor', { x: 7, y: 9 })
    await new Promise((r) => setTimeout(r, 40))
    expect(seen).toEqual([{ x: 7, y: 9 }])
  })
})
