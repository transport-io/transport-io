/**
 * Two guards that PROTOCOL.md describes and the implementation did not have.
 *
 * Both matter for the same reason: a peer is not this library. A second implementation
 * written from the spec will do what the spec permits, and both of these were places where
 * what we accept is wider than what we document - which is the direction that costs
 * somebody memory or a surprise, rather than merely failing a strict peer.
 */
/**
 * Proves these normative statements, which name this file back. The link is checked
 * from both ends by `scripts/check-norms.ts`; see D82.
 *
 *   cap-decided-by-frame-type
 */
import { describe, expect, test } from 'bun:test'
import { encodePayload } from './codec.ts'
import { buildEventTable, defineContract, type MapOf, type$ } from './contract.ts'
import { encodeDatagram } from './datagram.ts'
import { encodeFrame, FrameDecoder } from './framer.ts'
import {
  Codec,
  EVENT_ID_NOT_APPLICABLE,
  FrameType,
  LENGTH_PREFIX_BYTES,
  MAX_CALL_PAYLOAD_BYTES,
  MAX_EMIT_PAYLOAD_BYTES,
  STREAM_HEADER_BYTES,
} from './protocol.ts'
import { Session } from './session.ts'
import { loopbackPair } from './transport/loopback.ts'
import type { Connection } from './transport/types.ts'

const contract = defineContract({
  chat: { lane: 'reliable', payload: type$<{ body: string }>() },
  cursor: { lane: 'unreliable', payload: type$<{ x: number }>() },
})
interface AppMap extends MapOf<typeof contract> {}
void (0 as unknown as AppMap)

/** Just the header, declaring `payloadLength` bytes it never sends. */
function headerDeclaring(type: number, payloadLength: number): Uint8Array {
  const out = new Uint8Array(LENGTH_PREFIX_BYTES + STREAM_HEADER_BYTES)
  const view = new DataView(out.buffer)
  view.setUint32(0, STREAM_HEADER_BYTES + payloadLength, false)
  view.setUint8(4, type)
  view.setUint8(5, Codec.JSON)
  view.setUint16(6, 0, false)
  view.setUint32(8, 1, false)
  return out
}

describe('the payload cap is per frame type, as §5.3 says', () => {
  test('an EMIT frame declaring more than the emit cap is refused', () => {
    const decoder = new FrameDecoder()
    // Was accepted: the decoder enforced MAX_CALL_PAYLOAD_BYTES (16 MiB) for every frame
    // type, so a peer could declare 16 MiB on the emit lane whose documented cap is 1 MiB
    // and the decoder would sit there buffering toward it.
    expect(() =>
      decoder.push(headerDeclaring(FrameType.EMIT, MAX_EMIT_PAYLOAD_BYTES + 1)),
    ).toThrow(/WT_PAYLOAD_TOO_LARGE/)
  })

  test('a CALL_REQUEST at the emit cap plus one is still fine - calls have their own cap', () => {
    const decoder = new FrameDecoder()
    // No over-tightening: §5.3 gives calls 16 MiB precisely because a call is the
    // documented home for payloads too large to emit.
    expect(() =>
      decoder.push(headerDeclaring(FrameType.CALL_REQUEST, MAX_EMIT_PAYLOAD_BYTES + 1)),
    ).not.toThrow()
  })

  test('nothing may exceed the universal cap, whatever its type', () => {
    const decoder = new FrameDecoder()
    expect(() =>
      decoder.push(headerDeclaring(FrameType.CALL_RESPONSE, MAX_CALL_PAYLOAD_BYTES + 1)),
    ).toThrow(/WT_PAYLOAD_TOO_LARGE/)
  })

  test('a real round-trip frame still decodes', () => {
    const decoder = new FrameDecoder()
    const frame = encodeFrame({
      type: FrameType.EMIT,
      codec: Codec.JSON,
      eventId: 7,
      payload: encodePayload({ body: 'hi' }),
    })
    expect(decoder.push(frame).length).toBe(1)
  })
})

describe('a datagram arriving before the handshake is discarded', () => {
  test('it is not decoded and delivered', async () => {
    const [ours, theirs]: [Connection, Connection] = loopbackPair(1200)
    theirs.onEmitStream(() => {}) // never sends a handshake back
    const table = await buildEventTable(contract)
    const session = new Session(ours, { table, origin: 1 })
    void session.start().catch(() => undefined)

    const seen: unknown[] = []
    session.on('cursor', (p) => seen.push(p))

    const id = table.byName('cursor')?.id as number
    theirs.sendDatagram(
      encodeDatagram(
        { eventId: id, origin: 0x99, sequence: 1, payload: encodePayload({ x: 1 }) },
        1200,
      ),
    )
    await new Promise((r) => setTimeout(r, 50))

    // The reliable lane has had a `#negotiated` guard all along; the unreliable lane had none,
    // so a pre-handshake datagram was decoded and delivered here while PROTOCOL.md §7 and
    // ADR 0009 both say it is discarded silently. A second implementer drops it; this one
    // rendered it - and the application sees an event from a session it has not agreed a
    // contract with.
    expect(seen).toEqual([])
    void EVENT_ID_NOT_APPLICABLE
  })
})
