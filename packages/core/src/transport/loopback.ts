/**
 * An in-memory Connection pair. Test-only, and deliberately not faithful: it delivers
 * datagrams reliably and in order, which real datagrams do not. It exists to exercise the
 * session, room and framing layers under Bun without loading the native addon (D14).
 *
 * Anything that depends on real unreliability belongs in a *.node.test.ts against the
 * actual transport.
 *
 * It can lose the connection as well as close it. `close()` is the handshake: the peer
 * learns the code and the reason. `drop()` on the link is a killed process or a dead path:
 * nobody is told anything, every open stream errors, and the platform-shaped `closed`
 * underneath rejects, as the WebTransport specification says a session's does. The seam's
 * `closed` is that promise through `closedOf`, the mapping every adapter uses, so the abrupt
 * case in the parity suite asks this transport the same question it asks the others.
 */
import { closedOf } from './closed.ts'
import type { BidiStream, CloseInfo, Connection, Transport } from './types.ts'

/** A byte pipe whose controller is kept, so a drop can error both of its ends. */
function pipe(track: Set<TransformStreamDefaultController<Uint8Array>>): {
  readable: ReadableStream<Uint8Array>
  writable: WritableStream<Uint8Array>
} {
  let controller!: TransformStreamDefaultController<Uint8Array>
  const stream = new TransformStream<Uint8Array, Uint8Array>({
    start(c) {
      controller = c
    },
  })
  track.add(controller)
  return stream
}

class Side implements Connection {
  peer!: Side
  #emitStreamCb: ((r: ReadableStream<Uint8Array>) => void) | undefined
  #bidiCb: ((s: BidiStream) => void) | undefined
  #datagramCb: ((b: Uint8Array) => void) | undefined
  // A real transport queues an incoming stream or datagram until the application reads
  // it. Dispatching immediately would drop anything that arrives before the peer has
  // registered its handler, which is a race the real thing does not have.
  readonly #pendingEmit: ReadableStream<Uint8Array>[] = []
  readonly #pendingBidi: BidiStream[] = []
  readonly #pendingDatagrams: Uint8Array[] = []
  #resolveClosed!: (info: { closeCode: number; reason: string }) => void
  #rejectClosed!: (cause: Error) => void
  #closedFlag = false
  readonly closed: Promise<CloseInfo>
  #maxDatagram: number
  readonly #kind: Transport
  /** Every pipe this side opened, so a drop can error them. */
  readonly #pipes = new Set<TransformStreamDefaultController<Uint8Array>>()

  constructor(maxDatagram: number, kind: Transport) {
    this.#maxDatagram = maxDatagram
    this.#kind = kind
    this.closed = closedOf(
      new Promise<{ closeCode: number; reason: string }>((res, rej) => {
        this.#resolveClosed = res
        this.#rejectClosed = rej
      }),
    )
  }

  async openEmitStream(): Promise<WritableStream<Uint8Array>> {
    const { readable, writable } = pipe(this.#pipes)
    queueMicrotask(() => this.peer.#acceptEmit(readable))
    return writable
  }
  onEmitStream(cb: (r: ReadableStream<Uint8Array>) => void): void {
    this.#emitStreamCb = cb
    while (this.#pendingEmit.length > 0)
      cb(this.#pendingEmit.shift() as ReadableStream<Uint8Array>)
  }
  #acceptEmit(r: ReadableStream<Uint8Array>): void {
    if (this.#emitStreamCb === undefined) this.#pendingEmit.push(r)
    else this.#emitStreamCb(r)
  }

  async openBidi(): Promise<BidiStream> {
    const up = pipe(this.#pipes)
    const down = pipe(this.#pipes)
    queueMicrotask(() =>
      this.peer.#acceptBidi({ readable: up.readable, writable: down.writable }),
    )
    return { readable: down.readable, writable: up.writable }
  }
  onBidi(cb: (s: BidiStream) => void): void {
    this.#bidiCb = cb
    while (this.#pendingBidi.length > 0) cb(this.#pendingBidi.shift() as BidiStream)
  }
  #acceptBidi(s: BidiStream): void {
    if (this.#bidiCb === undefined) this.#pendingBidi.push(s)
    else this.#bidiCb(s)
  }

  sendDatagram(bytes: Uint8Array): void {
    if (this.#closedFlag) return
    // Mirrors the real transport: an oversized datagram is accepted and discarded with no
    // error. Our layer checks the size before ever reaching here.
    if (bytes.byteLength > this.#maxDatagram) return
    const copy = bytes.slice()
    queueMicrotask(() => this.peer.#acceptDatagram(copy))
  }
  onDatagram(cb: (b: Uint8Array) => void): void {
    this.#datagramCb = cb
    while (this.#pendingDatagrams.length > 0) cb(this.#pendingDatagrams.shift() as Uint8Array)
  }
  #acceptDatagram(b: Uint8Array): void {
    if (this.#datagramCb === undefined) this.#pendingDatagrams.push(b)
    else this.#datagramCb(b)
  }
  maxDatagramSize(): number {
    return this.#maxDatagram
  }

  reliability(): 'supports-unreliable' {
    return 'supports-unreliable'
  }

  kind(): Transport {
    return this.#kind
  }

  close(code: number, reason: string): void {
    if (this.#closedFlag) return
    this.#closedFlag = true
    this.#resolveClosed({ closeCode: code, reason })
    queueMicrotask(() => this.peer.close(code, reason))
  }

  /** The connection is gone and nobody said so: streams error, the platform `closed` rejects. */
  drop(): void {
    if (this.#closedFlag) return
    this.#closedFlag = true
    const gone = new Error('connection lost')
    for (const c of this.#pipes) {
      try {
        c.error(gone)
      } catch {
        // Already closed or errored, which is where it was going.
      }
    }
    this.#pipes.clear()
    this.#rejectClosed(gone)
  }
}

export interface LoopbackLink {
  /**
   * Loses the connection with no close from either side, which is what a killed peer looks
   * like from the survivor. Both ends settle, since in one process both ends are observed.
   */
  drop(): void
}

/**
 * `kind` is what the pair reports itself as. The default is the native transport; a pair
 * reporting `'websocket'` exercises the refusal a fallback session meets when its contract
 * has an undeclared unreliable event, without a socket anywhere.
 */
export function loopbackPair(
  maxDatagram = 1024,
  kind: Transport = 'webtransport',
): [Connection, Connection, LoopbackLink] {
  const a = new Side(maxDatagram, kind)
  const b = new Side(maxDatagram, kind)
  a.peer = b
  b.peer = a
  return [
    a,
    b,
    {
      drop: () => {
        a.drop()
        b.drop()
      },
    },
  ]
}
