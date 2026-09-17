import { CloseCode } from './protocol.ts'

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
  | 'WT_UDP_UNREACHABLE'
  | 'WT_LANE_UNAVAILABLE'
  | 'WT_CERT_EXPIRED'
  | 'WT_PORT_IN_USE'
  | 'WT_UNAUTHORIZED'

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

/**
 * The server's `authorize` refused this peer, and said why. `reason` is what `refuse(reason)`
 * was given on the server, or `'refused'` where `authorize` returned `null`. The code is
 * `WT_UNAUTHORIZED`, so `error.code` branches on the refusal and `error.reason` on its cause,
 * and nothing has to read the message. A refusal is an answer about this request, so a client
 * that reconnects on its own stops: the same request would be refused again.
 */
export class RefusedError extends TransportError {
  readonly reason: string

  constructor(reason: string) {
    super(
      'WT_UNAUTHORIZED',
      `the server refused this connection: ${reason}`,
      'The same request will be refused again, so a client that reconnects on its own has stopped. Obtain a valid credential, then disconnect() and connect().',
    )
    this.name = 'RefusedError'
    this.reason = reason
  }
}

/** What `authorize` returning `null` reports as its reason. */
export const DEFAULT_REFUSAL_REASON = 'refused'

const CLOSE_REMEDIES: Readonly<Record<number, readonly [TransportErrorCode, string]>> = {
  [CloseCode.WT_PROTOCOL_VERSION_MISMATCH]: [
    'WT_PROTOCOL_VERSION_MISMATCH',
    'Deploy both sides on the same library version.',
  ],
  [CloseCode.WT_CONTRACT_MISMATCH]: [
    'WT_CONTRACT_MISMATCH',
    'Deploy the same contract on both ends.',
  ],
  [CloseCode.WT_HANDSHAKE_TIMEOUT]: [
    'WT_HANDSHAKE_TIMEOUT',
    'The peer saw no handshake from this side in time. Connect again.',
  ],
  [CloseCode.WT_PEER_TOO_SLOW]: [
    'WT_PEER_TOO_SLOW',
    'This side was not consuming as fast as the peer emits. Handle events faster, or move the high-rate event to the unreliable lane.',
  ],
  [CloseCode.WT_PROTOCOL_ERROR]: [
    'WT_PROTOCOL_ERROR',
    'The peer met a framing violation from this side. Both ends need the same library version.',
  ],
  [CloseCode.WT_RELIABILITY_REFUSED]: [
    'WT_RELIABILITY_REFUSED',
    "Declare a fallback on every unreliable event, for example unreliable(schema, { fallback: 'newest' }), or connect over WebTransport.",
  ],
}

/**
 * What a session close code means to the application it closed on, or `undefined` where the
 * close is not an error: `WT_NO_ERROR`, a lost connection, a code this version does not know.
 * An idle timeout is `WT_SESSION_CLOSED`, because the remedy is to connect again.
 */
export function errorForClose(code: number, reason: string): TransportError | undefined {
  if (code === CloseCode.WT_UNAUTHORIZED) {
    return new RefusedError(reason === '' ? DEFAULT_REFUSAL_REASON : reason)
  }
  if (code === CloseCode.WT_IDLE_TIMEOUT) {
    return new TransportError(
      'WT_SESSION_CLOSED',
      `the session closed as WT_IDLE_TIMEOUT${reason === '' ? '' : `: ${reason}`}`,
      'The path went quiet past the idle deadline. Connect again.',
    )
  }
  const known = CLOSE_REMEDIES[code]
  if (known === undefined) return undefined
  return new TransportError(
    known[0],
    `the peer closed the session as ${known[0]}${reason === '' ? '' : `: ${reason}`}`,
    known[1],
  )
}
