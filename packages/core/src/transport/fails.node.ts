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
 *   - its server never learns that a silent peer is gone: a killed client was still a
 *     session 240 s later on a server that sent nothing, and gone 8 s after one that sent
 *     anything, so a listener's session sends a liveness probe
 */
import { Http3Server, quicheLoaded, WebTransport } from '@fails-components/webtransport'
import { decide } from '../authorize.ts'
import { Client, type ClientOptions } from '../client.ts'
import type { AnyMap, Registered } from '../contract.ts'
import { TransportError } from '../errors.ts'
import { DATAGRAM_CONSERVATIVE_FLOOR } from '../protocol.ts'
import { OwnedTimers } from '../timers.ts'
import { closedOf } from './closed.ts'
import { assertUdpPortFree } from './port.node.ts'
import { handshakeFailure, probe, probeTarget } from './probe.ts'
import type { Authorize, BidiStream, CloseInfo, Connection, ConnectRequest } from './types.ts'

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
  readonly header?: Record<string, string>
  readonly peerAddress?: string
  readonly userData?: { path?: string }
}

/**
 * How often a listener's session sends an empty datagram. The stack gives up on a peer once
 * something it sent goes unacknowledged, about 8 s later, and never otherwise, so a server
 * with nothing to say has to say nothing on purpose. A receiver discards a datagram shorter
 * than its header (PROTOCOL.md §7.2), so the probe needs no cooperation from the peer. The
 * same interval as the WebSocket mapping's keepalive.
 */
const LIVENESS_PROBE_MS = 15_000
const PROBE = new Uint8Array(0)

class FailsConnection implements Connection {
  readonly #session: AnySession
  readonly closed: Promise<CloseInfo>
  readonly data: unknown
  readonly #timers = new OwnedTimers()
  #datagramWriter: WritableStreamDefaultWriter<Uint8Array> | undefined

  constructor(session: AnySession, opts: { data?: unknown; probeMs?: number } = {}) {
    this.#session = session
    this.data = opts.data
    // The binding rejects `closed` for a session that fails before it is connected, and the
    // specification rejects it for any abrupt end. The seam never does; see `closed.ts`.
    this.closed = closedOf(session.closed)
    if (opts.probeMs !== undefined) {
      // Does not hold a process open, and ends with the session whichever side ended it.
      this.#timers.every(opts.probeMs, () => this.sendDatagram(PROBE)).unref()
      void this.closed.then(() => this.#timers.clearAll())
    }
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

  kind(): 'webtransport' {
    return 'webtransport'
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

export interface Http3ServerOptions<D = undefined> {
  readonly port: number
  readonly host?: string
  readonly cert: string
  readonly privKey: string
  readonly secret?: string
  readonly path?: string
  /**
   * Decides each peer before its session is accepted, from the request that opened it. What
   * it returns is `peer.data`; `null` closes the session as `WT_UNAUTHORIZED` before the
   * handshake, so the peer never receives the event table.
   */
  readonly authorize?: Authorize<D>
}

export interface Http3Listener<D = undefined> {
  readonly port: number
  sessions(): AsyncIterable<Connection & { readonly data?: D }>
  stop(): void
}

/** The request a session was opened with, as `authorize` sees it. */
function requestOf(session: AnySession): ConnectRequest {
  const raw = session.userData?.path ?? session.header?.[':path'] ?? '/'
  const at = raw.indexOf('?')
  return {
    path: at === -1 ? raw : raw.slice(0, at),
    query: new URLSearchParams(at === -1 ? '' : raw.slice(at + 1)),
    peerAddress: session.peerAddress ?? '',
    headers: session.header ?? {},
  }
}

/**
 * Only `Http3Server` is ever constructed. `Http2Server` and `reliability: 'both'` exist in
 * the dependency and are never used: a server that does not offer the HTTP/2 mapping
 * cannot be negotiated into it, whatever a client supports. That is the real enforcement
 * of the no-fallback rule, and it is browser-independent (D10, ADR 0003).
 */
export async function listenHttp3<D = undefined>(
  opts: Http3ServerOptions<D>,
): Promise<Http3Listener<D>> {
  // The binding binds a held UDP port without a word, and the server then never hears a
  // session. Probed first, so a taken port is an error here and not a silence later.
  await assertUdpPortFree(opts.port, opts.host ?? '127.0.0.1')
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
    setRequestCallback: (
      cb: (args: { header: Record<string, string> }) => Promise<{
        status: number
        path: string
        header: Record<string, string>
        userData: { path: string }
      }>,
    ) => void
  }

  // The binding routes a session by the whole `:path`, query included, so `/?token=x` never
  // reached a listener on `/`. The callback strips the query for routing and keeps the
  // original for `authorize`, which is the one place a browser can put a token.
  server.setRequestCallback(async ({ header }) => {
    const raw = header[':path'] ?? '/'
    const at = raw.indexOf('?')
    const pathname = at === -1 ? raw : raw.slice(0, at)
    return { status: 200, path: pathname, header, userData: { path: raw } }
  })

  server.startServer()
  await server.ready
  const path = opts.path ?? '/'

  return {
    port: server.port ?? opts.port,
    stop: () => server.stopServer(),
    async *sessions(): AsyncIterable<Connection & { readonly data?: D }> {
      const reader = server.sessionStream(path).getReader()
      for (;;) {
        const { value, done } = await reader.read()
        if (done) return
        if (value === undefined) continue
        // A session that fails before it is ready rejects both `ready` and `closed`. Thrown
        // from here it would end this generator, and with it every later accept.
        void value.closed.catch(() => undefined)
        try {
          await value.ready
        } catch {
          continue
        }
        // A refusal closes the session before this side sends frame 0, so the peer learns
        // why and learns nothing else.
        const session = value
        const verdict = await decide(opts.authorize, () => requestOf(session))
        if (!verdict.accepted) {
          session.close({ closeCode: verdict.code, reason: verdict.reason })
          continue
        }
        yield new FailsConnection(value, {
          data: verdict.data,
          probeMs: LIVENESS_PROBE_MS,
        }) as Connection & { readonly data?: D }
      }
    },
  }
}

/**
 * The listener `transport-io dev` prepared for this process.
 *
 * The CLI mints the certificate and passes it by environment, so a project's server file is
 * `await server.listen(await listenDev())` and never reads a certificate path, a port, or an
 * environment variable itself.
 */
export async function listenDev<D = undefined>(
  opts: { readonly authorize?: Authorize<D> } = {},
): Promise<Http3Listener<D>> {
  const cert = process.env.TRANSPORT_IO_DEV_CERT
  const privKey = process.env.TRANSPORT_IO_DEV_KEY
  const port = process.env.TRANSPORT_IO_DEV_WT_PORT
  if (cert === undefined || privKey === undefined || port === undefined) {
    throw new TransportError(
      'WT_DEV_ONLY',
      'listenDev() found no certificate in the environment',
      'Start this process with `npx transport-io dev`, which mints the certificate and sets it. Use listenHttp3 with your own certificate otherwise.',
    )
  }
  return await listenHttp3<D>({
    port: Number(port),
    host: '127.0.0.1',
    cert,
    privKey,
    path: '/',
    ...(opts.authorize === undefined ? {} : { authorize: opts.authorize }),
  })
}

export interface Http3ConnectOptions {
  readonly url: string
  readonly certificateHash: Uint8Array
  /** As `BrowserConnectOptions.probe`: where to ask over HTTPS once the handshake has failed. */
  readonly probe?: string | false
}

export async function connectHttp3(opts: Http3ConnectOptions): Promise<Connection> {
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
    // The same split the browser connector makes, for the same reason: the binding's error
    // says no more than the browser's, and a Node client behind a corporate egress is the
    // blocked-UDP case as often as a page is.
    const target = opts.probe === false ? undefined : (opts.probe ?? probeTarget(opts.url))
    const outcome = target === undefined ? 'skipped' : await probe(target)
    throw handshakeFailure(opts.url, target, outcome, cause)
  }
  return new FailsConnection(wt)
}

/** Everything `Client` needs except `connect`, which is what this module supplies. */
export interface Http3ClientOptions
  extends Omit<ClientOptions, 'connect'>,
    Http3ConnectOptions {}

/**
 * A connected client over the native transport, in one call.
 *
 * The Node counterpart of `browserClient`. Every integration test in this repository opened
 * with the same two statements and the same arrow, which is the argument for it.
 *
 * **Pass the map explicitly, or register it.** See `browserClient` for why the type argument
 * is not inferred from `contract`, and D100 for the measurement behind it.
 */
export async function http3Client<M extends AnyMap = Registered>(
  options: Http3ClientOptions,
): Promise<Client<M>> {
  const client = new Client<M>({ ...options, connect: () => connectHttp3(options) })
  await client.connect()
  return client
}
