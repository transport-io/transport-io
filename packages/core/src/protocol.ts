/**
 * The single source of truth for every normative constant in PROTOCOL.md.
 *
 * `scripts/check-docs.ts` parses the tables out of PROTOCOL.md and asserts they match
 * these values, so a document and an implementation cannot drift. Change one and the
 * build fails until you change the other.
 */

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

/** PROTOCOL.md §4.1 */
export const HANDSHAKE_DEADLINE_MS = 5000
/** PROTOCOL.md §10.2 */
export const CLOSE_REASON_MAX_BYTES = 1024

/** PROTOCOL.md §10.1 — one byte, because the browser API clamps stream codes to an octet. */
export const ResetCode = {
  WT_NO_ERROR: 0,
  WT_ABORTED: 1,
  WT_HANDLER_ERROR: 2,
  WT_PROTOCOL_ERROR: 3,
  WT_UNSUPPORTED_CODEC: 4,
  WT_PAYLOAD_TOO_LARGE: 5,
  WT_HANDSHAKE_INCOMPLETE: 6,
  WT_UNKNOWN_EVENT: 7,
  WT_VALIDATION_FAILED: 8,
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
