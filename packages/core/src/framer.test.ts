import { describe, expect, test } from 'bun:test'
/**
 * Proves these normative statements, which name this file back. The link is checked
 * from both ends by `scripts/check-norms.ts`; see D82.
 *
 *   protocol-error-not-processed
 *   reserved-field-zero
 *   length-minimum-nine
 *   zero-length-payload-rejected
 *   codec-must-be-json
 */
import fc from 'fast-check'
import { TransportError } from './errors.ts'
import { encodeFrame, type Frame, FrameDecoder } from './framer.ts'
import {
  Codec,
  EVENT_ID_NOT_APPLICABLE,
  FrameType,
  MAX_EMIT_PAYLOAD_BYTES,
  STREAM_HEADER_BYTES,
} from './protocol.ts'

const emit = (payload: Uint8Array, eventId = 0x31e06f7d): Frame => ({
  type: FrameType.EMIT,
  codec: Codec.JSON,
  eventId,
  payload,
})

const concat = (parts: Uint8Array[]): Uint8Array => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.byteLength, 0))
  let at = 0
  for (const p of parts) {
    out.set(p, at)
    at += p.byteLength
  }
  return out
}

/** Cut a buffer into chunks of at most `max` bytes, as a QUIC reader would deliver it. */
const chunkBy = (buf: Uint8Array, max: number): Uint8Array[] => {
  const out: Uint8Array[] = []
  for (let i = 0; i < buf.byteLength; i += max)
    out.push(buf.slice(i, Math.min(i + max, buf.byteLength)))
  return out
}

describe('wire layout', () => {
  // Explicit byte assertions, never a snapshot. A snapshot records whatever the code
  // did, including the bug.
  test('encodes exactly the header PROTOCOL.md §5 specifies', () => {
    const bytes = encodeFrame(emit(new Uint8Array([0xaa, 0xbb]), 0x31e06f7d))
    expect([...bytes]).toEqual([
      0x00,
      0x00,
      0x00,
      0x0a, // Length = 8 header + 2 payload, big-endian
      0x02, // Type = EMIT
      0x01, // Codec = JSON
      0x00,
      0x00, // Reserved, MUST be zero
      0x31,
      0xe0,
      0x6f,
      0x7d, // Event ID, big-endian
      0xaa,
      0xbb, // payload
    ])
  })

  test('Length counts the bytes after itself, never itself', () => {
    const bytes = encodeFrame(emit(new Uint8Array(5)))
    const declared = new DataView(bytes.buffer).getUint32(0, false)
    expect(declared).toBe(STREAM_HEADER_BYTES + 5)
    expect(bytes.byteLength).toBe(4 + declared)
  })
})

describe('the four framing edge cases', () => {
  test('a read delivering half a frame yields nothing and holds the bytes', () => {
    const whole = encodeFrame(emit(new Uint8Array([1, 2, 3, 4, 5, 6])))
    const d = new FrameDecoder()
    const half = Math.floor(whole.byteLength / 2)
    expect(d.push(whole.slice(0, half))).toEqual([])
    expect(d.buffered).toBe(half)
    const [frame] = d.push(whole.slice(half))
    expect(frame?.payload).toEqual(new Uint8Array([1, 2, 3, 4, 5, 6]))
    expect(d.buffered).toBe(0)
  })

  test('a read delivering three frames yields three', () => {
    const d = new FrameDecoder()
    const buf = concat([
      encodeFrame(emit(new Uint8Array([1]))),
      encodeFrame(emit(new Uint8Array([2, 2]))),
      encodeFrame(emit(new Uint8Array([3, 3, 3]))),
    ])
    const frames = d.push(buf)
    expect(frames.map((f) => [...f.payload])).toEqual([[1], [2, 2], [3, 3, 3]])
    expect(d.buffered).toBe(0)
  })

  test('a frame split across three reads is recovered', () => {
    const whole = encodeFrame(emit(new Uint8Array([9, 8, 7, 6, 5, 4, 3, 2, 1])))
    const a = whole.slice(0, 3) // mid length prefix
    const b = whole.slice(3, 10) // mid header
    const c = whole.slice(10) // remainder
    const d = new FrameDecoder()
    expect(d.push(a)).toEqual([])
    expect(d.push(b)).toEqual([])
    const [frame] = d.push(c)
    expect(frame?.payload).toEqual(new Uint8Array([9, 8, 7, 6, 5, 4, 3, 2, 1]))
  })

  test('an oversized emit payload is refused by our layer, before the transport sees it', () => {
    expect(() => encodeFrame(emit(new Uint8Array(MAX_EMIT_PAYLOAD_BYTES + 1)))).toThrow(
      TransportError,
    )
    try {
      encodeFrame(emit(new Uint8Array(MAX_EMIT_PAYLOAD_BYTES + 1)))
    } catch (e) {
      expect((e as TransportError).code).toBe('WT_PAYLOAD_TOO_LARGE')
      expect((e as TransportError).remedy).toContain('call')
    }
  })
})

describe('the measured fixture: 51 writes arrived as 217 reads', () => {
  // Not a curiosity. On the reference transport, 50 small writes plus one large write
  // were delivered as 217 reads with a largest chunk of 1220 bytes - the small writes
  // coincidentally survived as discrete reads and the large one shattered. That is the
  // case that passes naively in development and fails under load.
  test('recovers exact boundaries when chunking bears no relation to frames', () => {
    const payloads = [
      ...Array.from({ length: 50 }, (_, i) => new Uint8Array(10).fill(i)),
      new Uint8Array(200_000).fill(7),
    ]
    const wire = concat(payloads.map((p) => encodeFrame(emit(p))))
    const chunks = chunkBy(wire, 1220)

    expect(chunks.length).toBeGreaterThan(150) // fragmentation is the point

    const d = new FrameDecoder()
    const got: Uint8Array[] = []
    for (const c of chunks) for (const f of d.push(c)) got.push(f.payload)

    expect(got.length).toBe(51)
    expect(d.buffered).toBe(0)
    for (let i = 0; i < payloads.length; i++) {
      expect(got[i]).toEqual(payloads[i] as Uint8Array)
    }
  })
})

describe('property: round-trip survives any chunking', () => {
  test('random frames, random chunk boundaries, exact recovery', () => {
    fc.assert(
      fc.property(
        fc.array(
          fc.record({
            type: fc.constantFrom(FrameType.EMIT, FrameType.CALL_REQUEST, FrameType.JOIN),
            eventId: fc.integer({ min: 0, max: 0xffffffff }),
            payload: fc.uint8Array({ minLength: 1, maxLength: 300 }),
          }),
          { minLength: 1, maxLength: 25 },
        ),
        fc.array(fc.integer({ min: 1, max: 64 }), { minLength: 1, maxLength: 60 }),
        (specs, cutSizes) => {
          const frames: Frame[] = specs.map((s) => ({
            type: s.type,
            codec: Codec.JSON,
            eventId: s.eventId,
            payload: s.payload,
          }))
          const wire = concat(frames.map(encodeFrame))

          // Walk arbitrary, repeating cut sizes across the whole buffer.
          const d = new FrameDecoder()
          const got: Frame[] = []
          let at = 0
          let k = 0
          while (at < wire.byteLength) {
            const n = cutSizes[k % cutSizes.length] as number
            const end = Math.min(at + n, wire.byteLength)
            for (const f of d.push(wire.slice(at, end))) got.push(f)
            at = end
            k++
          }

          expect(d.buffered).toBe(0)
          expect(got.length).toBe(frames.length)
          for (let i = 0; i < frames.length; i++) {
            const a = frames[i] as Frame
            const b = got[i] as Frame
            expect(b.type).toBe(a.type)
            expect(b.eventId).toBe(a.eventId)
            expect([...b.payload]).toEqual([...a.payload])
          }
        },
      ),
      { numRuns: 400 },
    )
  })

  test('property: one byte at a time is still exact', () => {
    fc.assert(
      fc.property(
        fc.array(fc.uint8Array({ minLength: 1, maxLength: 40 }), {
          minLength: 1,
          maxLength: 8,
        }),
        (payloads) => {
          const wire = concat(payloads.map((p) => encodeFrame(emit(p))))
          const d = new FrameDecoder()
          const got: Uint8Array[] = []
          for (const byte of wire)
            for (const f of d.push(new Uint8Array([byte]))) got.push(f.payload)
          expect(got.length).toBe(payloads.length)
          for (let i = 0; i < payloads.length; i++) {
            expect([...(got[i] as Uint8Array)]).toEqual([...(payloads[i] as Uint8Array)])
          }
        },
      ),
      { numRuns: 150 },
    )
  })
})

describe('zero-length frames are a protocol error on both sides (upstream #365)', () => {
  // Writing a zero-length Uint8Array freezes the reference server with a quic_bug rather
  // than erroring, so a zero-length frame must never reach the transport and must never
  // be forwarded to an application. Stream close terminates a response, so no zero-length
  // sentinel was ever needed. Both directions get their own test.

  test('ENCODE refuses a zero-length payload', () => {
    try {
      encodeFrame(emit(new Uint8Array(0)))
      throw new Error('expected a throw')
    } catch (e) {
      expect(e).toBeInstanceOf(TransportError)
      expect((e as TransportError).code).toBe('WT_PROTOCOL_ERROR')
      expect((e as TransportError).remedy).toContain('at least one byte')
    }
  })

  test('DECODE refuses a length prefix of 0', () => {
    try {
      new FrameDecoder().push(new Uint8Array([0, 0, 0, 0, 0, 0, 0, 0]))
      throw new Error('expected a throw')
    } catch (e) {
      expect((e as TransportError).code).toBe('WT_PROTOCOL_ERROR')
    }
  })

  test('DECODE refuses a header-only frame rather than forwarding an empty payload', () => {
    // Length === STREAM_HEADER_BYTES declares a well-formed header and no payload, which
    // is the case that would otherwise surface to an application as an empty message.
    const bytes = new Uint8Array(4 + STREAM_HEADER_BYTES)
    new DataView(bytes.buffer).setUint32(0, STREAM_HEADER_BYTES, false)
    bytes[4] = FrameType.EMIT
    bytes[5] = Codec.JSON
    expect(() => new FrameDecoder().push(bytes)).toThrow(TransportError)
  })

  test('DECODE never yields a frame with an empty payload, for any input', () => {
    fc.assert(
      fc.property(fc.uint8Array({ minLength: 0, maxLength: 200 }), (junk) => {
        const d = new FrameDecoder()
        let frames: Frame[] = []
        try {
          frames = d.push(junk)
        } catch {
          return // refusing is the correct outcome
        }
        for (const f of frames) expect(f.payload.byteLength).toBeGreaterThan(0)
      }),
      { numRuns: 500 },
    )
  })
})

describe('malformed input is refused with a code and a remedy', () => {
  test('a zero-filled buffer cannot parse as a valid frame', () => {
    const d = new FrameDecoder()
    expect(() => d.push(new Uint8Array(32))).toThrow(TransportError)
  })

  test('an unsupported codec names the remedy', () => {
    const bytes = encodeFrame(emit(new Uint8Array([1])))
    bytes[5] = 0x02
    try {
      new FrameDecoder().push(bytes)
      throw new Error('expected a throw')
    } catch (e) {
      expect((e as TransportError).code).toBe('WT_UNSUPPORTED_CODEC')
      expect((e as TransportError).remedy).toContain('0x01')
    }
  })

  test('a non-zero reserved field is refused', () => {
    const bytes = encodeFrame(emit(new Uint8Array([1])))
    bytes[6] = 0x01
    expect(() => new FrameDecoder().push(bytes)).toThrow(TransportError)
  })

  test('EVENT_ID_NOT_APPLICABLE round-trips for stream-scoped frames', () => {
    const f: Frame = {
      type: FrameType.CALL_RESPONSE,
      codec: Codec.JSON,
      eventId: EVENT_ID_NOT_APPLICABLE,
      payload: new Uint8Array([1]),
    }
    const [back] = new FrameDecoder().push(encodeFrame(f))
    expect(back?.eventId).toBe(0)
  })
})
