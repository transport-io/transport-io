/**
 * An in-memory Connection pair. Test-only, and deliberately not faithful: it delivers
 * datagrams reliably and in order, which real datagrams do not. It exists to exercise the
 * session, room and framing layers under Bun without loading the native addon (D14).
 *
 * Anything that depends on real unreliability belongs in a *.node.test.ts against the
 * actual transport.
 */
import type { BidiStream, CloseInfo, Connection } from './types.ts'

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
  #resolveClosed!: (info: CloseInfo) => void
  #closedFlag = false
  readonly closed: Promise<CloseInfo>
  #maxDatagram: number

  constructor(maxDatagram: number) {
    this.#maxDatagram = maxDatagram
    this.closed = new Promise<CloseInfo>((res) => {
      this.#resolveClosed = res
    })
  }

  async openEmitStream(): Promise<WritableStream<Uint8Array>> {
    const { readable, writable } = new TransformStream<Uint8Array, Uint8Array>()
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
    const up = new TransformStream<Uint8Array, Uint8Array>()
    const down = new TransformStream<Uint8Array, Uint8Array>()
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

  close(code: number, reason: string): void {
    if (this.#closedFlag) return
    this.#closedFlag = true
    const info = { code, reason }
    this.#resolveClosed(info)
    queueMicrotask(() => this.peer.close(code, reason))
  }
}

export function loopbackPair(maxDatagram = 1024): [Connection, Connection] {
  const a = new Side(maxDatagram)
  const b = new Side(maxDatagram)
  a.peer = b
  b.peer = a
  return [a, b]
}
