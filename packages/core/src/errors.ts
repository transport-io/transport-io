/** Every error carries a stable code and a sentence saying what to do about it. */
export type TransportErrorCode =
  | 'WT_NO_SUPPORT'
  | 'WT_DATAGRAM_TOO_LARGE'
  | 'WT_ROOM_NOT_JOINED'
  | 'WT_SESSION_CLOSED'
  | 'WT_ABORTED'
  | 'WT_HANDLER_ERROR'
  | 'WT_PROTOCOL_ERROR'
  | 'WT_UNSUPPORTED_CODEC'
  | 'WT_PAYLOAD_TOO_LARGE'
  | 'WT_HANDSHAKE_INCOMPLETE'
  | 'WT_UNKNOWN_EVENT'
  | 'WT_VALIDATION_FAILED'
  | 'WT_PROTOCOL_VERSION_MISMATCH'
  | 'WT_CONTRACT_MISMATCH'
  | 'WT_HANDSHAKE_TIMEOUT'
  | 'WT_PEER_TOO_SLOW'
  | 'WT_TOO_MANY_STREAMS'
  | 'WT_RELIABILITY_REFUSED'

export class TransportError extends Error {
  readonly code: TransportErrorCode
  readonly remedy: string

  constructor(code: TransportErrorCode, message: string, remedy: string) {
    super(`${code}: ${message} - ${remedy}`)
    this.name = 'TransportError'
    this.code = code
    this.remedy = remedy
  }
}
