/**
 * The single source of truth for every normative constant in PROTOCOL.md.
 *
 * `scripts/check-docs.ts` parses the tables out of PROTOCOL.md and asserts they match
 * these values, so a document and an implementation cannot drift. Change one and the
 * build fails until you change the other.
 */

/** PROTOCOL.md §4.2 — Stage 0 requires exact equality and refuses otherwise. */
export const PROTOCOL_VERSION = 0

/** PROTOCOL.md §5.2 */
export const FrameType = {
  HANDSHAKE: 0x01,
  EMIT: 0x02,
  CALL_REQUEST: 0x03,
  CALL_RESPONSE: 0x04,
  CALL_ERROR: 0x05,
  JOIN: 0x06,
  LEAVE: 0x07,
} as const
export type FrameType = (typeof FrameType)[keyof typeof FrameType]

const FRAME_TYPES: ReadonlySet<number> = new Set(Object.values(FrameType))
export function isFrameType(v: number): v is FrameType {
  return FRAME_TYPES.has(v)
}

/** PROTOCOL.md §5.3. `0x00` is permanently reserved so a zero-filled buffer cannot parse. */
export const Codec = { JSON: 0x01 } as const
export type Codec = (typeof Codec)[keyof typeof Codec]

/** PROTOCOL.md §5.4 — used by frames whose meaning comes from the stream, not the table. */
export const EVENT_ID_NOT_APPLICABLE = 0x00000000

/** PROTOCOL.md §5.1 — stream frame field budget. */
export const LENGTH_PREFIX_BYTES = 4
export const STREAM_HEADER_BYTES = 8
export const STREAM_FRAME_OVERHEAD_BYTES: number = LENGTH_PREFIX_BYTES + STREAM_HEADER_BYTES

/** `Length` counts every byte AFTER itself: header plus payload. Never itself. */
export const MIN_LENGTH: number = STREAM_HEADER_BYTES + 1
export const MAX_EMIT_PAYLOAD_BYTES = 1_048_576
export const MAX_CALL_PAYLOAD_BYTES = 16_777_216

/** PROTOCOL.md §7.2 — datagram field budget. */
export const DATAGRAM_HEADER_BYTES = 13
/** PROTOCOL.md §7.4 — used only when the transport reports nothing usable. */
export const DATAGRAM_CONSERVATIVE_FLOOR = 1024
export const DATAGRAM_CONSERVATIVE_PAYLOAD_MAX: number =
  DATAGRAM_CONSERVATIVE_FLOOR - DATAGRAM_HEADER_BYTES

/** PROTOCOL.md §9 — per-peer bounds. Numbers, not adjectives. */
export const DATAGRAM_QUEUE_MAX = 64
export const EMIT_QUEUE_MAX = 256
/** PROTOCOL.md §10.1 code 9 — a rejected open resets that stream, never the session. */
export const MAX_CONCURRENT_CALL_STREAMS = 256
/** Checked at dequeue, not enqueue: overflow handles a burst, TTL handles a stall. */
export const DATAGRAM_TTL_MS = 150

/** PROTOCOL.md §7.3 — a receiver discards (origin, event) sequence state after this idle. */
export const SEQUENCE_STATE_RETENTION_MS = 60_000
/** PROTOCOL.md §7.3 — a released Origin waits this long before returning to the pool. */
export const ORIGIN_QUARANTINE_MS = 120_000
/** PROTOCOL.md §7.3 — a departed host's ordinal waits this long before reallocation. */
export const HOST_ORDINAL_QUARANTINE_MS = 300_000
/** PROTOCOL.md §7.3 — stated ceiling on concurrent session hosts. */
export const MAX_SESSION_HOSTS = 1024

/** PROTOCOL.md §4.1 */
export const HANDSHAKE_DEADLINE_MS = 5000
/** PROTOCOL.md §10.2 */
export const CLOSE_REASON_MAX_BYTES = 1024

/** PROTOCOL.md §10.1 — one byte, because the browser API clamps stream codes to an octet. */
export const ResetCode = {
  WT_NO_ERROR: 0,
  WT_ABORTED: 1,
  WT_TOO_MANY_STREAMS: 9,
} as const
export type ResetCode = (typeof ResetCode)[keyof typeof ResetCode]

/** PROTOCOL.md §10.2 */
export const CloseCode = {
  WT_NO_ERROR: 0,
  WT_PROTOCOL_VERSION_MISMATCH: 1000,
  WT_CONTRACT_MISMATCH: 1001,
  WT_HANDSHAKE_TIMEOUT: 1002,
  WT_PEER_TOO_SLOW: 1003,
  WT_PROTOCOL_ERROR: 1004,
  WT_RELIABILITY_REFUSED: 1006,
} as const
export type CloseCode = (typeof CloseCode)[keyof typeof CloseCode]
