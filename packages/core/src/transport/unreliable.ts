/**
 * Wraps a Connection and makes its datagram path behave like a real one: lossy,
 * reordering, duplicating and delayed, on command.
 *
 * Test-only. The plain loopback delivers datagrams reliably and in order, which is
 * convenient and a lie - every guarantee the datagram lane deliberately does not make
 * goes unexercised against it. This exists so loss, reordering and duplication are forced
 * deliberately rather than waited for.
 *
 * Streams are passed through untouched: they are reliable and ordered, and pretending
 * otherwise would test the wrong thing.
 */
import type { BidiStream, CloseInfo, Connection } from './types.ts'

export interface UnreliableOptions {
  /** Drop the nth datagram, 1-based, for every n in this set. */
  readonly dropAt?: ReadonlySet<number>
  /** Deliver the nth datagram twice. */
  readonly duplicateAt?: ReadonlySet<number>
  /** Hold the nth datagram and release it after the following one. */
  readonly delayAt?: ReadonlySet<number>
}

export class UnreliableConnection implements Connection {
  readonly #inner: Connection
  readonly #opts: UnreliableOptions
  #sent = 0
  #held: Uint8Array | undefined

  constructor(inner: Connection, opts: UnreliableOptions = {}) {
    this.#inner = inner
    this.#opts = opts
  }

  get sentCount(): number {
    return this.#sent
  }

  sendDatagram(bytes: Uint8Array): void {
    const n = ++this.#sent

    if (this.#opts.dropAt?.has(n) === true) return // silently lost, as the lane permits

    if (this.#opts.delayAt?.has(n) === true) {
      this.#held = bytes
      return
    }

    this.#inner.sendDatagram(bytes)
    if (this.#opts.duplicateAt?.has(n) === true) this.#inner.sendDatagram(bytes)

    // A held datagram arrives after the one that overtook it: reordering, not loss.
    if (this.#held !== undefined) {
      const held = this.#held
      this.#held = undefined
      this.#inner.sendDatagram(held)
    }
  }

  openEmitStream(): Promise<WritableStream<Uint8Array>> {
    return this.#inner.openEmitStream()
  }
  onEmitStream(cb: (readable: ReadableStream<Uint8Array>) => void): void {
    this.#inner.onEmitStream(cb)
  }
  openBidi(): Promise<BidiStream> {
    return this.#inner.openBidi()
  }
  onBidi(cb: (stream: BidiStream) => void): void {
    this.#inner.onBidi(cb)
  }
  onDatagram(cb: (bytes: Uint8Array) => void): void {
    this.#inner.onDatagram(cb)
  }
  maxDatagramSize(): number {
    return this.#inner.maxDatagramSize()
  }
  reliability(): 'pending' | 'reliable-only' | 'supports-unreliable' | undefined {
    return this.#inner.reliability()
  }
  close(code: number, reason: string): void {
    this.#inner.close(code, reason)
  }
  get closed(): Promise<CloseInfo> {
    return this.#inner.closed
  }
}
