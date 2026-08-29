/**
 * The browser Connection, over the platform's own `WebTransport`.
 *
 * Nothing here is imported at module scope - `WebTransport` is read inside connect() -
 * so importing this on a server, which Next.js will do, is safe. There is no native
 * addon and no binding, which is why this file is not `*.node.ts`.
 */
import { TransportError } from '../errors.ts'
import { DATAGRAM_CONSERVATIVE_FLOOR } from '../protocol.ts'
import type { BidiStream, CloseInfo, Connection } from './types.ts'

interface PlatformSession {
  readonly ready: Promise<void>
  readonly closed: Promise<{ closeCode?: number; reason?: string }>
  readonly reliability?: string
  createUnidirectionalStream: () => Promise<WritableStream<Uint8Array>>
  readonly incomingUnidirectionalStreams: ReadableStream<ReadableStream<Uint8Array>>
  createBidirectionalStream: () => Promise<BidiStream>
  readonly incomingBidirectionalStreams: ReadableStream<BidiStream>
  readonly datagrams: {
    readonly readable: ReadableStream<Uint8Array>
    createWritable?: () => WritableStream<Uint8Array>
    readonly writable?: WritableStream<Uint8Array>
    readonly maxDatagramSize?: number
  }
  close: (info: { closeCode: number; reason: string }) => void
}

class BrowserConnection implements Connection {
  readonly #s: PlatformSession
  readonly closed: Promise<CloseInfo>
  #dgWriter: WritableStreamDefaultWriter<Uint8Array> | undefined

  constructor(s: PlatformSession) {
    this.#s = s
    this.closed = s.closed.then((i) => ({ code: i.closeCode ?? 0, reason: i.reason ?? '' }))
  }

  openEmitStream(): Promise<WritableStream<Uint8Array>> {
    return this.#s.createUnidirectionalStream()
  }
  onEmitStream(cb: (r: ReadableStream<Uint8Array>) => void): void {
    void this.#pump(this.#s.incomingUnidirectionalStreams, cb)
  }
  openBidi(): Promise<BidiStream> {
    return this.#s.createBidirectionalStream()
  }
  onBidi(cb: (s: BidiStream) => void): void {
    void this.#pump(this.#s.incomingBidirectionalStreams, cb)
  }
  onDatagram(cb: (b: Uint8Array) => void): void {
    void this.#pump(this.#s.datagrams.readable, cb)
  }

  sendDatagram(bytes: Uint8Array): void {
    // `datagrams.writable` is deprecated in favour of createWritable(); support both,
    // because which one exists depends on the engine.
    this.#dgWriter ??= (
      this.#s.datagrams.createWritable?.() ?? this.#s.datagrams.writable
    )?.getWriter()
    void this.#dgWriter?.write(bytes).catch(() => undefined)
  }

  maxDatagramSize(): number {
    const r = this.#s.datagrams.maxDatagramSize
    return typeof r === 'number' && r > 0 ? r : DATAGRAM_CONSERVATIVE_FLOOR
  }

  reliability(): 'pending' | 'reliable-only' | 'supports-unreliable' | undefined {
    const r = this.#s.reliability
    return r === 'pending' || r === 'reliable-only' || r === 'supports-unreliable'
      ? r
      : undefined
  }

  close(code: number, reason: string): void {
    try {
      this.#s.close({ closeCode: code, reason: reason.slice(0, 1024) })
    } catch {
      // Already closed.
    }
  }

  async #pump<T>(stream: ReadableStream<T>, cb: (v: T) => void): Promise<void> {
    const reader = stream.getReader()
    try {
      for (;;) {
        const { value, done } = await reader.read()
        if (done) break
        if (value !== undefined) cb(value)
      }
    } catch {
      // The session went away; `closed` reports it.
    }
  }
}

export interface BrowserConnectOptions {
  readonly url: string
  /** SHA-256 over the DER of the leaf certificate. Required for a pinned certificate. */
  readonly certificateHash?: Uint8Array
}

export async function connectBrowser(opts: BrowserConnectOptions): Promise<Connection> {
  const WT = (
    globalThis as { WebTransport?: new (url: string, init?: unknown) => PlatformSession }
  ).WebTransport
  if (WT === undefined) {
    throw new TransportError(
      'WT_NO_SUPPORT',
      'this runtime has no WebTransport',
      'There is no fallback: a WebSocket would silently make the unreliable lane reliable. Use Chrome or Firefox.',
    )
  }
  const session = new WT(opts.url, {
    ...(opts.certificateHash === undefined
      ? {}
      : { serverCertificateHashes: [{ algorithm: 'sha-256', value: opts.certificateHash }] }),
    // Honoured on Firefox and Safari, silently ignored on Chrome. The server refusing to
    // offer HTTP/2 at all is the actual guarantee.
    requireUnreliable: true,
  })
  try {
    await session.ready
  } catch (cause) {
    /**
     * Every reason this can fail looks identical from JavaScript.
     *
     * Measured in Chromium against a real server: a hash that does not match, a correct hash
     * for an expired certificate, and nothing listening on the port all produce the same
     * `WebTransportError` with the message "Opening handshake failed.", `code: 0`,
     * `source: "session"`, and no own enumerable properties at all. There is nothing to
     * branch on, so this deliberately does not guess which one it was: claiming "certificate
     * expired" when the server is simply down would be a confident wrong answer, and that is
     * worse than an honest vague one.
     *
     * What it can do is turn a dead end into a checklist, ordered by what is cheapest to
     * rule out.
     */
    throw new TransportError(
      'WT_HANDSHAKE_FAILED',
      `the WebTransport handshake to ${opts.url} failed`,
      'The browser reports one error for every cause here, so check in this order: (1) the ' +
        'server is running and its UDP port is reachable; (2) if you pinned a certificate, ' +
        'that it has not passed its 14-day limit; (3) that the hash matches the certificate ' +
        'the server is serving - it is SHA-256 over the DER, not over cert.pem. ' +
        '`npx transport-io dev` handles all three for local development.',
      cause,
    )
  }
  return new BrowserConnection(session)
}
