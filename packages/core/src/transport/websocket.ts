/**
 * The emit lane over a WebSocket. PROTOCOL.md §3.3.
 *
 * A WebSocket is one ordered, reliable pipe per direction, which is what the emit lane
 * already is (D32), so this Connection is the socket itself: `openEmitStream` writes to it,
 * `onEmitStream` reads from it, and the framer above runs untouched, treating each message
 * as bytes of the same stream. Everything else on the seam refuses. There are no
 * bidirectional streams, so a session on this transport carries no calls and no `stream()`,
 * and there are no datagrams: an unreliable event whose contract declared a fallback travels
 * as a `DATAGRAM` frame on the emit lane instead, wrapped and unwrapped by the session (D122).
 *
 * What the socket does not give for free is write completion. A browser exposes only
 * `bufferedAmount`, with no event when it drains, so the sink polls it before resolving a
 * write. Without that every write would resolve at once, and the emit queue's 256-frame
 * bound would measure nothing: `writer.ready` on the reference binding in a new costume
 * (D93). `websocket.node.test.ts` reaches the bound on a real socket with the peer paused,
 * and shows it unreachable with the polling off.
 *
 * Nor does it give liveness. TCP reports a dead path late or never, and a WebSocket has no
 * idle timeout of its own, so the mapping carries one (D126): an empty message after
 * `WS_KEEPALIVE_INTERVAL_MS` with nothing sent, consumed by the receiver as no bytes at all,
 * and a close as `WT_IDLE_TIMEOUT` after `WS_IDLE_TIMEOUT_MS` with nothing received.
 */
import { TransportError } from '../errors.ts'
import {
  CloseCode,
  DATAGRAM_CONSERVATIVE_FLOOR,
  WS_CLOSE_NORMAL,
  WS_CLOSE_OFFSET,
  WS_CLOSE_REASON_MAX_BYTES,
  WS_IDLE_TIMEOUT_MS,
  WS_KEEPALIVE_INTERVAL_MS,
} from '../protocol.ts'
import { type OwnedTimer, OwnedTimers } from '../timers.ts'
import type { BidiStream, CloseInfo, Connection } from './types.ts'

/**
 * What this needs from a socket: the WHATWG surface, which browsers, Node and `ws` share.
 * `readyState` 1 is open on every one of them.
 */
export interface SocketLike {
  binaryType: string
  readonly bufferedAmount: number
  readonly readyState: number
  send(data: Uint8Array): void
  close(code?: number, reason?: string): void
  addEventListener(type: 'message', listener: (ev: { readonly data: unknown }) => void): void
  addEventListener(
    type: 'close',
    listener: (ev: { readonly code: number; readonly reason: string }) => void,
  ): void
  addEventListener(type: 'error', listener: () => void): void
  addEventListener(type: 'open', listener: () => void): void
}

const OPEN = 1

/**
 * Bytes a write may leave queued in the socket and still count as complete. Absolute. Above
 * it the write parks, which is what lets the emit queue fill and its bound fire.
 */
export const WS_SEND_LOW_WATER_BYTES = 65_536
/** How long a parked write waits between looks at `bufferedAmount`. */
const POLL_MS = 4
/** §3.3: the keepalive is an empty message, which carries no bytes of the stream. */
const KEEPALIVE = new Uint8Array(0)

export interface WebSocketConnectionOptions {
  /** For the test that proves the bound; production never sets it. */
  readonly lowWaterBytes?: number
  /** For the tests that prove the deadline; production never sets them. */
  readonly keepaliveIntervalMs?: number
  readonly idleTimeoutMs?: number
}

export class WebSocketConnection implements Connection {
  readonly #socket: SocketLike
  readonly #lowWater: number
  readonly #keepaliveMs: number
  readonly #idleMs: number
  readonly #timers = new OwnedTimers()
  #idleTimer: OwnedTimer | undefined
  #sentAt = Date.now()
  readonly #readable: ReadableStream<Uint8Array>
  #inbound: ReadableStreamDefaultController<Uint8Array> | undefined
  #closing = false
  #settleClosed!: (info: CloseInfo) => void
  readonly closed: Promise<CloseInfo>

  constructor(socket: SocketLike, opts: WebSocketConnectionOptions = {}) {
    this.#socket = socket
    this.#lowWater = opts.lowWaterBytes ?? WS_SEND_LOW_WATER_BYTES
    this.#keepaliveMs = opts.keepaliveIntervalMs ?? WS_KEEPALIVE_INTERVAL_MS
    this.#idleMs = opts.idleTimeoutMs ?? WS_IDLE_TIMEOUT_MS
    socket.binaryType = 'arraybuffer'
    this.#readable = new ReadableStream<Uint8Array>({
      start: (controller) => {
        this.#inbound = controller
      },
    })
    this.closed = new Promise<CloseInfo>((resolve) => {
      this.#settleClosed = resolve
    })
    socket.addEventListener('close', (ev) => {
      this.#closing = true
      this.#timers.clearAll()
      this.#endInbound()
      this.#settleClosed({ code: fromWebSocketCloseCode(ev.code), reason: ev.reason })
    })
    socket.addEventListener('error', () => {
      // A close event follows every error, and that is the one report `closed` makes.
    })
    socket.addEventListener('message', (ev) => {
      const bytes = toBytes(ev.data)
      if (bytes === undefined) {
        // §3.3: binary messages only. A text frame is not a framing accident, it is another
        // protocol, and the lane cannot recover from it any more than from a bad length.
        this.close(CloseCode.WT_PROTOCOL_ERROR, 'a text message on the emit lane')
        return
      }
      // Anything from the peer, a keepalive included, is proof of life.
      this.#armIdle()
      // §3.3: an empty message is the keepalive, and carries no bytes of the stream.
      if (bytes.byteLength === 0) return
      this.#inbound?.enqueue(bytes)
    })
    // Neither timer holds a process open: the socket does that, for as long as it is open.
    this.#timers.every(this.#keepaliveMs, () => this.#keepalive()).unref()
    this.#armIdle()
  }

  async openEmitStream(): Promise<WritableStream<Uint8Array>> {
    const socket = this.#socket
    const lowWater = this.#lowWater
    const gone = (): TransportError =>
      new TransportError(
        'WT_SESSION_CLOSED',
        'the WebSocket closed with a write pending',
        'Connect again. A frame handed to a closed socket was never sent.',
      )
    return new WritableStream<Uint8Array>({
      write: async (chunk) => {
        if (socket.readyState !== OPEN) throw gone()
        socket.send(chunk)
        this.#sentAt = Date.now()
        // The bound above this sink counts frames whose write has not completed. A socket
        // reports completion through `bufferedAmount` alone, so this is where a write waits
        // while the peer is slow, and where a resolve-at-once would hide the whole backlog.
        while (socket.bufferedAmount > lowWater) {
          if (socket.readyState !== OPEN) throw gone()
          await new Promise((resolve) => setTimeout(resolve, POLL_MS))
        }
      },
      abort: (reason) => {
        this.close(CloseCode.WT_PROTOCOL_ERROR, String(reason))
      },
    })
  }

  /** The socket is the peer's emit stream, so it is delivered at once rather than awaited. */
  onEmitStream(cb: (readable: ReadableStream<Uint8Array>) => void): void {
    cb(this.#readable)
  }

  openBidi(): Promise<BidiStream> {
    return Promise.reject(laneUnavailable())
  }

  onBidi(): void {
    // Nothing will ever arrive: the peer has no bidirectional streams to open either.
  }

  sendDatagram(): void {
    // The session wraps unreliable frames on the emit lane on this transport, so a datagram
    // reaching here is a bug in transport-io rather than a condition to absorb quietly.
    throw new TransportError(
      'WT_PROTOCOL_ERROR',
      'a datagram reached the WebSocket connection',
      'Unreliable frames travel as DATAGRAM frames on the emit lane here. Report this.',
    )
  }

  onDatagram(): void {
    // Datagrams arrive as DATAGRAM frames on the emit stream; see the session.
  }

  /** The same ceiling as the native transport, so an application's limit never moves with it. */
  maxDatagramSize(): number {
    return DATAGRAM_CONSERVATIVE_FLOOR
  }

  reliability(): 'reliable-only' {
    return 'reliable-only'
  }

  kind(): 'websocket' {
    return 'websocket'
  }

  close(code: number, reason: string): void {
    if (this.#closing) return
    this.#closing = true
    this.#timers.clearAll()
    try {
      this.#socket.close(toWebSocketCloseCode(code), truncateCloseReason(reason))
    } catch {
      // Already closing underneath us.
    }
    // Closed from this side is closed now, as it is on every other transport. The closing
    // handshake continues underneath, and against a peer that has stopped reading it never
    // completes: `ws` waits thirty seconds before giving up on it, and a session that has
    // decided to disconnect a slow peer must not sit behind that peer's silence.
    this.#endInbound()
    this.#settleClosed({ code, reason })
  }

  #endInbound(): void {
    try {
      this.#inbound?.close()
    } catch {
      // Closed twice, which is the peer and the socket both saying the same thing.
    }
  }

  /**
   * Sent when nothing else has been for an interval. The check runs on a timer of the same
   * period, so the longest silence before a keepalive is two intervals, well inside the
   * peer's deadline.
   */
  #keepalive(): void {
    if (this.#closing || this.#socket.readyState !== OPEN) return
    if (Date.now() - this.#sentAt < this.#keepaliveMs) return
    try {
      this.#socket.send(KEEPALIVE)
      this.#sentAt = Date.now()
    } catch {
      // Closing underneath us; the close event releases the timer.
    }
  }

  /** Re-armed by every message. When it fires, the path is dead or the peer sends no keepalive. */
  #armIdle(): void {
    this.#idleTimer?.cancel()
    this.#idleTimer = this.#timers.after(this.#idleMs, () => {
      this.close(CloseCode.WT_IDLE_TIMEOUT, `no message from the peer for ${this.#idleMs} ms`)
    })
    this.#idleTimer.unref()
  }
}

function laneUnavailable(): TransportError {
  return new TransportError(
    'WT_LANE_UNAVAILABLE',
    'call() and stream() need a WebTransport session, and this one is on a WebSocket',
    'Check client.native before calling: it is null on a fallback session. Emits, and unreliable events that declare a fallback, still work here.',
  )
}

function toBytes(data: unknown): Uint8Array | undefined {
  if (data instanceof ArrayBuffer) return new Uint8Array(data)
  if (ArrayBuffer.isView(data)) {
    return new Uint8Array(data.buffer, data.byteOffset, data.byteLength)
  }
  return undefined
}

/** §3.3: `WT_NO_ERROR` is a normal closure; every other session code rides in the private range. */
export function toWebSocketCloseCode(code: number): number {
  return code === CloseCode.WT_NO_ERROR ? WS_CLOSE_NORMAL : WS_CLOSE_OFFSET + code
}

/** The inverse, with the socket's own codes (a lost connection is 1006) passed through as they are. */
export function fromWebSocketCloseCode(code: number): number {
  if (code === WS_CLOSE_NORMAL) return CloseCode.WT_NO_ERROR
  if (code >= WS_CLOSE_OFFSET + 1000 && code <= WS_CLOSE_OFFSET + 1999)
    return code - WS_CLOSE_OFFSET
  return code
}

/** Whole characters only, so a cut never leaves half a code point on the wire. */
export function truncateCloseReason(reason: string): string {
  const encoder = new TextEncoder()
  if (encoder.encode(reason).byteLength <= WS_CLOSE_REASON_MAX_BYTES) return reason
  let out = ''
  for (const ch of reason) {
    if (encoder.encode(out + ch).byteLength > WS_CLOSE_REASON_MAX_BYTES) break
    out += ch
  }
  return out
}

export interface WebSocketConnectOptions {
  /** `ws://` or `wss://`. A `wss://` origin needs a certificate the platform trusts. */
  readonly url: string
}

/**
 * The fallback connector, for `withFallback`. Runtime-neutral: it reads the global
 * `WebSocket`, which browsers, Node and Bun all provide.
 */
export async function connectWebSocket(opts: WebSocketConnectOptions): Promise<Connection> {
  const WS = (globalThis as { WebSocket?: new (url: string) => SocketLike }).WebSocket
  if (WS === undefined) {
    throw new TransportError(
      'WT_NO_SUPPORT',
      'this runtime has no WebSocket',
      'Use a browser, Node 22 or later, or Bun.',
    )
  }
  const socket = new WS(opts.url)
  socket.binaryType = 'arraybuffer'
  await new Promise<void>((resolve, reject) => {
    socket.addEventListener('open', () => resolve())
    socket.addEventListener('close', (ev) => {
      reject(
        new TransportError(
          'WT_HANDSHAKE_FAILED',
          `the WebSocket handshake to ${opts.url} failed, close code ${ev.code}`,
          'Check that the server is running, that its WebSocket listener is reachable over TCP, and that a wss:// certificate is one this platform trusts.',
        ),
      )
    })
    socket.addEventListener('error', () => {
      // The close event that follows carries the code; rejecting here would report twice.
    })
  })
  return new WebSocketConnection(socket)
}
