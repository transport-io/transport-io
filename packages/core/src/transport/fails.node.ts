/**
 * The reference transport, behind the seam.
 *
 * This file is the ONLY place that imports the WebTransport binding, and the
 * import-boundary lint rule enforces that: the binding loads a native addon that
 * segfaults Bun on exit, so anything touching it must be named `*.node.ts` and run under
 * Node (D14, ADR 0006).
 *
 * Everything ugly about the dependency is contained here:
 *   - it ships an HTTP/2 fallback that is on by default, which would silently make the
 *     unreliable lane reliable and ordered, so only `Http3Server` is ever constructed
 *   - oversized and blocked datagrams are accepted, discarded, and reported as success
 *   - `WebTransportError` omits the specification's `streamErrorCode`, so a reset code is
 *     recoverable only by parsing a message string
 */
import { Http3Server, quicheLoaded, WebTransport } from '@fails-components/webtransport'
import { TransportError } from '../errors.ts'
import { DATAGRAM_CONSERVATIVE_FLOOR } from '../protocol.ts'
import type { BidiStream, CloseInfo, Connection } from './types.ts'

type AnySession = {
  readonly ready: Promise<void>
  readonly closed: Promise<{ closeCode?: number; reason?: string }>
  readonly reliability?: string
  createUnidirectionalStream: () => Promise<WritableStream<Uint8Array>>
  readonly incomingUnidirectionalStreams: ReadableStream<ReadableStream<Uint8Array>>
  createBidirectionalStream: () => Promise<BidiStream>
  readonly incomingBidirectionalStreams: ReadableStream<BidiStream>
  readonly datagrams: {
    readonly readable: ReadableStream<Uint8Array>
    createWritable: () => WritableStream<Uint8Array>
    readonly maxDatagramSize: number
  }
  close: (info: { closeCode: number; reason: string }) => void
}

/**
 * The reset code is only recoverable from the message text, because the error type omits
 * the field the specification defines. Parsing lives in exactly this one function, with a
 * test pinning the observed format, so the upstream defect stays contained.
 */
export function resetCodeFromError(error: unknown): number | undefined {
  const message = error instanceof Error ? error.message : String(error)
  const m = /code:\s*(\d+)/i.exec(message)
  return m?.[1] === undefined ? undefined : Number(m[1])
}

class FailsConnection implements Connection {
  readonly #session: AnySession
  readonly closed: Promise<CloseInfo>
  #datagramWriter: WritableStreamDefaultWriter<Uint8Array> | undefined

  constructor(session: AnySession) {
    this.#session = session
    this.closed = session.closed.then((info) => ({
      code: info.closeCode ?? 0,
      reason: info.reason ?? '',
    }))
  }

  async openEmitStream(): Promise<WritableStream<Uint8Array>> {
    return await this.#session.createUnidirectionalStream()
  }

  onEmitStream(cb: (readable: ReadableStream<Uint8Array>) => void): void {
    void (async () => {
      const reader = this.#session.incomingUnidirectionalStreams.getReader()
      try {
        for (;;) {
          const { value, done } = await reader.read()
          if (done) break
          if (value !== undefined) cb(value)
        }
      } catch {
        // The session closed underneath us; `closed` is the channel that reports it.
      }
    })()
  }

  async openBidi(): Promise<BidiStream> {
    return await this.#session.createBidirectionalStream()
  }

  onBidi(cb: (stream: BidiStream) => void): void {
    void (async () => {
      const reader = this.#session.incomingBidirectionalStreams.getReader()
      try {
        for (;;) {
          const { value, done } = await reader.read()
          if (done) break
          if (value !== undefined) cb(value)
        }
      } catch {
        // As above.
      }
    })()
  }

  sendDatagram(bytes: Uint8Array): void {
    // `datagrams.writable` is deprecated upstream in favour of createWritable().
    this.#datagramWriter ??= this.#session.datagrams.createWritable().getWriter()
    void this.#datagramWriter.write(bytes).catch(() => undefined)
  }

  onDatagram(cb: (bytes: Uint8Array) => void): void {
    void (async () => {
      const reader = this.#session.datagrams.readable.getReader()
      try {
        for (;;) {
          const { value, done } = await reader.read()
          if (done) break
          if (value !== undefined) cb(value)
        }
      } catch {
        // As above.
      }
    })()
  }

  maxDatagramSize(): number {
    const reported = this.#session.datagrams.maxDatagramSize
    // Chrome hardcodes 1024 regardless of the path, and this binding can report 0 before
    // the session settles, so a non-positive value falls back to the conservative floor.
    return typeof reported === 'number' && reported > 0 ? reported : DATAGRAM_CONSERVATIVE_FLOOR
  }

  reliability(): 'pending' | 'reliable-only' | 'supports-unreliable' | undefined {
    const r = this.#session.reliability
    return r === 'pending' || r === 'reliable-only' || r === 'supports-unreliable'
      ? r
      : undefined
  }

  close(code: number, reason: string): void {
    try {
      this.#session.close({ closeCode: code, reason: reason.slice(0, 1024) })
    } catch {
      // Closing an already-closed session is not an error worth propagating.
    }
  }
}

export interface Http3ServerOptions {
  readonly port: number
  readonly host?: string
  readonly cert: string
  readonly privKey: string
  readonly secret?: string
  readonly path?: string
}

export interface Http3Listener {
  readonly port: number
  sessions(): AsyncIterable<Connection>
  stop(): void
}

/**
 * Only `Http3Server` is ever constructed. `Http2Server` and `reliability: 'both'` exist in
 * the dependency and are never used: a server that does not offer the HTTP/2 mapping
 * cannot be negotiated into it, whatever a client supports. That is the real enforcement
 * of the no-fallback rule, and it is browser-independent (D10, ADR 0003).
 */
export async function listenHttp3(opts: Http3ServerOptions): Promise<Http3Listener> {
  const server = new Http3Server({
    port: opts.port,
    host: opts.host ?? '127.0.0.1',
    secret: opts.secret ?? 'transport-io',
    cert: opts.cert,
    privKey: opts.privKey,
  }) as unknown as {
    startServer: () => void
    stopServer: () => void
    ready: Promise<void>
    port: number | null
    sessionStream: (path: string) => ReadableStream<AnySession>
  }

  server.startServer()
  await server.ready
  const path = opts.path ?? '/'

  return {
    port: server.port ?? opts.port,
    stop: () => server.stopServer(),
    async *sessions(): AsyncIterable<Connection> {
      const reader = server.sessionStream(path).getReader()
      for (;;) {
        const { value, done } = await reader.read()
        if (done) return
        if (value === undefined) continue
        await value.ready
        yield new FailsConnection(value)
      }
    },
  }
}

export interface Http3ClientOptions {
  readonly url: string
  readonly certificateHash: Uint8Array
}

export async function connectHttp3(opts: Http3ClientOptions): Promise<Connection> {
  // The binding loads its native transport through a dynamic import and throws
  // `Lib quiche loading attempt did not end` if a client is constructed before it
  // settles. A process that also runs a server never sees this, because the server
  // awaits the same promise on the way up - which is exactly why it went unnoticed
  // until a client ran on its own.
  await quicheLoaded

  const wt = new WebTransport(opts.url, {
    serverCertificateHashes: [{ algorithm: 'sha-256', value: opts.certificateHash }],
    // Honoured on Firefox and Safari, silently ignored on Chrome. Defence in depth: the
    // server-side refusal above is the guarantee.
    requireUnreliable: true,
  } as never) as unknown as AnySession

  // `closed` rejects independently of `ready`. If the handshake fails, nothing has
  // attached to it yet and Node sees an unhandled rejection - which terminates a server
  // by default. Claim it before awaiting `ready`; FailsConnection re-reads the same
  // settled promise, so nothing is lost.
  const closedGuard = wt.closed.catch(() => undefined)

  try {
    await wt.ready
  } catch (cause) {
    await closedGuard
    throw new TransportError(
      'WT_SESSION_CLOSED',
      `could not open a session to ${opts.url}: ${(cause as Error).message}`,
      'Check the server is listening, that UDP reaches it, and that the certificate hash matches.',
    )
  }
  return new FailsConnection(wt)
}
