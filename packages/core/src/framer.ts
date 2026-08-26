/**
 * Stream framing, implemented to PROTOCOL.md §5.
 *
 * QUIC streams are byte streams and do not preserve write boundaries. Measured on the
 * reference transport, 51 writes arrived as 217 reads, and the large write fragmented
 * while the small ones happened to survive — which is the worst case, because naive
 * boundary-trusting code passes in development and fails under load. The length prefix
 * is the only thing that recovers frame boundaries, and nobody using this library should
 * ever have to think about it.
 */
import { TransportError } from './errors.ts'
import {
  Codec,
  EVENT_ID_NOT_APPLICABLE,
  FrameType,
  isFrameType,
  LENGTH_PREFIX_BYTES,
  MAX_CALL_PAYLOAD_BYTES,
  MAX_EMIT_PAYLOAD_BYTES,
  MIN_LENGTH,
  STREAM_HEADER_BYTES,
} from './protocol.ts'

export interface Frame {
  readonly type: FrameType
  readonly codec: number
  readonly eventId: number
  readonly payload: Uint8Array
}

/** §5.1 — the cap is per frame type: a call is the documented home for a large payload. */
export function maxPayloadFor(type: FrameType): number {
  return type === FrameType.CALL_REQUEST || type === FrameType.CALL_RESPONSE
    ? MAX_CALL_PAYLOAD_BYTES
    : MAX_EMIT_PAYLOAD_BYTES
}

export function encodeFrame(frame: Frame): Uint8Array {
  const payloadLength = frame.payload.byteLength
  if (payloadLength === 0) {
    throw new TransportError(
      'WT_PROTOCOL_ERROR',
      'a frame payload of zero bytes is not representable',
      'Stream close terminates a response, so no zero-length sentinel is needed. Send at least one byte.',
    )
  }
  const cap = maxPayloadFor(frame.type)
  if (payloadLength > cap) {
    throw new TransportError(
      'WT_PAYLOAD_TOO_LARGE',
      `payload is ${payloadLength} bytes and the cap for this frame type is ${cap}`,
      'Use a call rather than an emit, or split the payload.',
    )
  }

  const out = new Uint8Array(LENGTH_PREFIX_BYTES + STREAM_HEADER_BYTES + payloadLength)
  const view = new DataView(out.buffer)
  view.setUint32(0, STREAM_HEADER_BYTES + payloadLength, false)
  view.setUint8(4, frame.type)
  view.setUint8(5, frame.codec)
  view.setUint16(6, 0, false) // Reserved, MUST be zero
  view.setUint32(8, frame.eventId, false)
  out.set(frame.payload, LENGTH_PREFIX_BYTES + STREAM_HEADER_BYTES)
  return out
}

/**
 * Incremental decoder. Feed it whatever the transport hands you — a fragment, several
 * frames, or a frame split across many reads — and it yields whole frames only.
 */
export class FrameDecoder {
  #buf: Uint8Array = new Uint8Array(0)

  /** Bytes held pending a complete frame. Exposed so tests can assert nothing leaks. */
  get buffered(): number {
    return this.#buf.byteLength
  }

  push(chunk: Uint8Array): Frame[] {
    if (chunk.byteLength > 0) {
      const merged = new Uint8Array(this.#buf.byteLength + chunk.byteLength)
      merged.set(this.#buf, 0)
      merged.set(chunk, this.#buf.byteLength)
      this.#buf = merged
    }

    const frames: Frame[] = []
    for (;;) {
      if (this.#buf.byteLength < LENGTH_PREFIX_BYTES) break
      const view = new DataView(this.#buf.buffer, this.#buf.byteOffset, this.#buf.byteLength)
      const length = view.getUint32(0, false)

      if (length < MIN_LENGTH) {
        throw new TransportError(
          'WT_PROTOCOL_ERROR',
          `frame length ${length} is below the minimum of ${MIN_LENGTH}`,
          'A length of 0 or a header-only frame is a protocol error. Check the sender against PROTOCOL.md §5.1.',
        )
      }
      const payloadLength = length - STREAM_HEADER_BYTES
      if (payloadLength > MAX_CALL_PAYLOAD_BYTES) {
        throw new TransportError(
          'WT_PAYLOAD_TOO_LARGE',
          `frame declares a ${payloadLength}-byte payload, above every cap`,
          'Split the payload. See PROTOCOL.md §5.1.',
        )
      }

      const total = LENGTH_PREFIX_BYTES + length
      if (this.#buf.byteLength < total) break // partial frame: wait for more bytes

      const type = view.getUint8(4)
      if (!isFrameType(type)) {
        throw new TransportError(
          'WT_PROTOCOL_ERROR',
          `frame type 0x${type.toString(16).padStart(2, '0')} is reserved or unknown`,
          'Check the sender against the frame type table in PROTOCOL.md §5.2.',
        )
      }
      const codec = view.getUint8(5)
      if (codec !== Codec.JSON) {
        throw new TransportError(
          'WT_UNSUPPORTED_CODEC',
          `codec 0x${codec.toString(16).padStart(2, '0')} is not supported`,
          'This version speaks JSON only. Send codec 0x01.',
        )
      }
      if (view.getUint16(6, false) !== 0) {
        throw new TransportError(
          'WT_PROTOCOL_ERROR',
          'the reserved header field is not zero',
          'Zero bytes 6 and 7 of the frame header. See PROTOCOL.md §5.1.',
        )
      }
      const eventId = view.getUint32(8, false)
      const payloadStart = LENGTH_PREFIX_BYTES + STREAM_HEADER_BYTES
      // Copy rather than subarray: the caller keeps this past the next push().
      frames.push({
        type,
        codec,
        eventId,
        payload: this.#buf.slice(payloadStart, total),
      })
      this.#buf = this.#buf.slice(total)
    }
    return frames
  }
}

export { EVENT_ID_NOT_APPLICABLE }
