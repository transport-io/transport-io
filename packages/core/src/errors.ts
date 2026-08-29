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
  | 'WT_DEV_ONLY'
  | 'WT_HANDSHAKE_FAILED'
  | 'WT_CERT_EXPIRED'

export class TransportError extends Error {
  readonly code: TransportErrorCode
  readonly remedy: string

  /**
   * `cause` carries the error being wrapped, where there is one. The browser's
   * `WebTransportError` has no own enumerable properties, so wrapping it without keeping a
   * reference would throw away the only artefact anyone could inspect in a debugger.
   */
  constructor(code: TransportErrorCode, message: string, remedy: string, cause?: unknown) {
    super(`${code}: ${message} - ${remedy}`, cause === undefined ? undefined : { cause })
    this.name = 'TransportError'
    this.code = code
    this.remedy = remedy
  }
}
