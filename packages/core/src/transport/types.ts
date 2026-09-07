/**
 * The transport seam. Internal - not exported from the package (D21).
 *
 * It exists so the reference transport's defects stay in one place: it silently swallows
 * oversized and blocked datagrams, its error type omits the specification's
 * `streamErrorCode` so reset codes are only recoverable by parsing a message string, and
 * it ships a reliability fallback that must be actively disabled.
 */
/** What carries a session: every lane on `webtransport`, the reliable lane only on `websocket`. */
export type Transport = 'webtransport' | 'websocket'

export interface CloseInfo {
  readonly code: number
  readonly reason: string
}

export interface BidiStream {
  readonly readable: ReadableStream<Uint8Array>
  readonly writable: WritableStream<Uint8Array>
}

export interface Connection {
  /** One long-lived unidirectional stream per direction carries the whole emit lane. */
  openEmitStream(): Promise<WritableStream<Uint8Array>>
  onEmitStream(cb: (readable: ReadableStream<Uint8Array>) => void): void

  openBidi(): Promise<BidiStream>
  onBidi(cb: (stream: BidiStream) => void): void

  sendDatagram(bytes: Uint8Array): void
  onDatagram(cb: (bytes: Uint8Array) => void): void
  /** A property of the path, not a constant. Queried at send time, never cached. */
  maxDatagramSize(): number

  /**
   * `undefined` where the runtime does not implement the attribute - which includes the
   * dominant browser. Treated as "unknown, allowed"; only an explicit 'reliable-only' is
   * refused. See D10.
   */
  reliability(): 'pending' | 'reliable-only' | 'supports-unreliable' | undefined

  /**
   * A property of the connection, known at both ends from the listener or connector that
   * produced it, which is why the handshake never carries it. A session on anything but
   * `webtransport` is refused unless every unreliable event in the contract declares a
   * fallback (D121).
   */
  kind(): Transport

  close(code: number, reason: string): void
  readonly closed: Promise<CloseInfo>
}
