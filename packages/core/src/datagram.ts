/** Datagram header. PROTOCOL.md §7.1 — codec, event id, origin, sequence, then payload. */
import { TransportError } from './errors.ts'
import {
  Codec,
  DATAGRAM_CONSERVATIVE_FLOOR,
  DATAGRAM_HEADER_BYTES,
  EVENT_ID_NOT_APPLICABLE,
} from './protocol.ts'

export interface Datagram {
  readonly eventId: number
  readonly origin: number
  readonly sequence: number
  readonly payload: Uint8Array
}

/**
 * The usable size is a property of the path, not a constant, so it is queried at send
 * time. The floor is used only when the transport reports nothing usable.
 */
export function maxDatagramPayload(reportedMax: number): number {
  const effective = reportedMax > 0 ? reportedMax : DATAGRAM_CONSERVATIVE_FLOOR
  return Math.max(0, effective - DATAGRAM_HEADER_BYTES)
}

export function encodeDatagram(dg: Datagram, reportedMax: number): Uint8Array {
  if (dg.payload.byteLength === 0) {
    throw new TransportError(
      'WT_PROTOCOL_ERROR',
      'a datagram payload of zero bytes is not representable',
      'Send at least one byte. A zero-length write freezes some transports.',
    )
  }
  if (dg.eventId === EVENT_ID_NOT_APPLICABLE) {
    throw new TransportError(
      'WT_PROTOCOL_ERROR',
      'event id 0 is not valid on the datagram lane',
      'Datagrams always carry a contract event. Check the event table.',
    )
  }
  const limit = maxDatagramPayload(reportedMax)
  if (dg.payload.byteLength > limit) {
    // The transport accepts an oversized datagram, discards it, and reports success, so
    // this check is the only thing standing between a user and a silent drop.
    throw new TransportError(
      'WT_DATAGRAM_TOO_LARGE',
      `payload is ${dg.payload.byteLength} bytes and the path allows ${limit}`,
      'Shorten the payload, or declare this event on the stream lane where size is not capped this tightly.',
    )
  }

  const out = new Uint8Array(DATAGRAM_HEADER_BYTES + dg.payload.byteLength)
  const view = new DataView(out.buffer)
  view.setUint8(0, Codec.JSON)
  view.setUint32(1, dg.eventId, false)
  view.setUint32(5, dg.origin, false)
  view.setUint32(9, dg.sequence, false)
  out.set(dg.payload, DATAGRAM_HEADER_BYTES)
  return out
}

export function decodeDatagram(bytes: Uint8Array): Datagram {
  if (bytes.byteLength <= DATAGRAM_HEADER_BYTES) {
    throw new TransportError(
      'WT_PROTOCOL_ERROR',
      `datagram is ${bytes.byteLength} bytes, at or below the ${DATAGRAM_HEADER_BYTES}-byte header`,
      'A datagram must carry at least one payload byte. See PROTOCOL.md §7.2.',
    )
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const codec = view.getUint8(0)
  if (codec !== Codec.JSON) {
    throw new TransportError(
      'WT_UNSUPPORTED_CODEC',
      `codec 0x${codec.toString(16).padStart(2, '0')} is not supported`,
      'This version speaks JSON only. Send codec 0x01.',
    )
  }
  const eventId = view.getUint32(1, false)
  if (eventId === EVENT_ID_NOT_APPLICABLE) {
    throw new TransportError(
      'WT_PROTOCOL_ERROR',
      'event id 0 is not valid on the datagram lane',
      'Check the sender against PROTOCOL.md §7.2.',
    )
  }
  return {
    eventId,
    origin: view.getUint32(5, false),
    sequence: view.getUint32(9, false),
    payload: bytes.slice(DATAGRAM_HEADER_BYTES),
  }
}

/**
 * Last-write-wins keyed on (origin, event). PROTOCOL.md §7.3.
 *
 * Wrap is treated as circular over the 32-bit space: a difference greater than 2^31 reads
 * as wrap rather than regression.
 */
export class SequenceGate {
  readonly #seen = new Map<string, { seq: number; at: number }>()
  #staleReceived = 0

  get staleReceived(): number {
    return this.#staleReceived
  }

  /** Returns true when the datagram is fresh and should be delivered. */
  accept(origin: number, eventId: number, sequence: number, now: number): boolean {
    const key = `${origin}:${eventId}`
    const prev = this.#seen.get(key)
    if (prev !== undefined) {
      const delta = (sequence - prev.seq) >>> 0
      const isNewer = delta !== 0 && delta < 0x80000000
      if (!isNewer) {
        this.#staleReceived++
        return false
      }
    }
    this.#seen.set(key, { seq: sequence, at: now })
    return true
  }

  /** A receiver discards (origin, event) state after this idle, so origins can be reused. */
  sweep(now: number, retentionMs: number): void {
    for (const [key, v] of this.#seen) {
      if (now - v.at >= retentionMs) this.#seen.delete(key)
    }
  }

  get tracked(): number {
    return this.#seen.size
  }
}
