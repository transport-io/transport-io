/**
 * One side of a session. Both the server's view of a peer and the client's view of the
 * server are this class — the handshake is symmetric, and so is everything after it.
 */
import { decodePayload, encodePayload, validate } from './codec.ts'
import type { EventTable } from './contract.ts'
import { decodeDatagram, encodeDatagram, SequenceGate } from './datagram.ts'
import { TransportError } from './errors.ts'
import { encodeFrame, type Frame, FrameDecoder } from './framer.ts'
import { buildHandshake, type Negotiated, negotiate, parseHandshake } from './handshake.ts'
import {
  CloseCode,
  Codec,
  EVENT_ID_NOT_APPLICABLE,
  FrameType,
  HANDSHAKE_DEADLINE_MS,
  SEQUENCE_STATE_RETENTION_MS,
} from './protocol.ts'
import { DatagramQueue, EmitQueue, PeerTooSlowError, type QueueStats } from './queue.ts'
import type { Connection } from './transport/types.ts'

export interface SessionStats extends QueueStats {
  readonly staleReceived: number
}

export type EventHandler = (payload: unknown, meta: { readonly from: number }) => void

export interface SessionOptions {
  readonly table: EventTable
  readonly origin: number
  readonly validateInbound?: boolean
  readonly now?: () => number
  readonly handshakeDeadlineMs?: number
}

export class Session {
  readonly #conn: Connection
  readonly #table: EventTable
  readonly #origin: number
  readonly #validateInbound: boolean
  readonly #now: () => number
  readonly #deadlineMs: number

  readonly #handlers = new Map<string, Set<EventHandler>>()
  readonly #gate = new SequenceGate()
  readonly #dgQueue = new DatagramQueue<Uint8Array>()
  readonly #emitQueue = new EmitQueue<Uint8Array>()
  readonly #sequences = new Map<number, number>()
  readonly #controlHandlers = new Set<(type: number, body: unknown) => void>()

  #writer: WritableStreamDefaultWriter<Uint8Array> | undefined
  #writeChain: Promise<void> = Promise.resolve()
  #negotiated: Negotiated | undefined
  #handshakeResolve!: (n: Negotiated) => void
  #handshakeReject!: (e: unknown) => void
  #sweepTimer: ReturnType<typeof setInterval> | undefined

  /** Resolves when both sides have exchanged a valid handshake. */
  readonly ready: Promise<Negotiated>

  constructor(conn: Connection, opts: SessionOptions) {
    this.#conn = conn
    this.#table = opts.table
    this.#origin = opts.origin
    this.#validateInbound = opts.validateInbound ?? true
    this.#now = opts.now ?? (() => Date.now())
    this.#deadlineMs = opts.handshakeDeadlineMs ?? HANDSHAKE_DEADLINE_MS
    this.ready = new Promise<Negotiated>((res, rej) => {
      this.#handshakeResolve = res
      this.#handshakeReject = rej
    })
  }

  get origin(): number {
    return this.#origin
  }

  async start(): Promise<Negotiated> {
    this.#conn.onEmitStream((readable) => void this.#readEmitStream(readable))
    this.#conn.onDatagram((bytes) => this.#onDatagram(bytes))

    const writable = await this.#conn.openEmitStream()
    this.#writer = writable.getWriter()

    // Frame 0 of the emit stream. In-order delivery within a stream makes early traffic
    // impossible by construction, so there is no race to guard.
    await this.#write(
      encodeFrame({
        type: FrameType.HANDSHAKE,
        codec: Codec.JSON,
        eventId: EVENT_ID_NOT_APPLICABLE,
        payload: encodePayload(buildHandshake(this.#table)),
      }),
    )

    const timer = setTimeout(() => {
      this.#handshakeReject(
        new TransportError(
          'WT_HANDSHAKE_TIMEOUT',
          `no handshake within ${this.#deadlineMs}ms`,
          'The session opened but no application bytes arrived. Some browsers establish a WebTransport session and then never transmit; that combination is unsupported.',
        ),
      )
      this.#conn.close(CloseCode.WT_HANDSHAKE_TIMEOUT, 'handshake deadline')
    }, this.#deadlineMs)

    try {
      const n = await this.ready
      clearTimeout(timer)
      this.#sweepTimer = setInterval(() => {
        this.#gate.sweep(this.#now(), SEQUENCE_STATE_RETENTION_MS)
      }, SEQUENCE_STATE_RETENTION_MS)
      // Node returns a Timeout with unref; browsers return a number. Neither type is
      // available in both runtimes, so this is narrowed rather than assumed.
      ;(this.#sweepTimer as unknown as { unref?: () => void }).unref?.()
      return n
    } catch (e) {
      clearTimeout(timer)
      throw e
    }
  }

  /** JOIN and LEAVE are server-to-client notifications, so a client can keep an accurate
   *  view of its own membership. Rooms are server-authoritative; this is not a request. */
  onControl(cb: (type: number, body: unknown) => void): () => void {
    this.#controlHandlers.add(cb)
    return () => {
      this.#controlHandlers.delete(cb)
    }
  }

  on(event: string, handler: EventHandler): () => void {
    let set = this.#handlers.get(event)
    if (set === undefined) {
      set = new Set()
      this.#handlers.set(event, set)
    }
    set.add(handler)
    return () => {
      set.delete(handler)
    }
  }

  /** Fire and forget on whichever lane the contract declared. The call site never chooses. */
  emit(event: string, payload: unknown): void {
    const entry = this.#table.byName(event)
    if (entry === undefined) {
      throw new TransportError(
        'WT_UNKNOWN_EVENT',
        `'${event}' is not in the contract`,
        'Add it to the contract, or check the spelling.',
      )
    }
    const bytes = encodePayload(payload)
    if (entry.lane === 'datagram') {
      const seq = ((this.#sequences.get(entry.id) ?? 0) + 1) >>> 0 || 1
      this.#sequences.set(entry.id, seq)
      const dg = encodeDatagram(
        { eventId: entry.id, origin: this.#origin, sequence: seq, payload: bytes },
        this.#conn.maxDatagramSize(),
      )
      this.#dgQueue.push(dg, this.#now())
      this.#flushDatagrams()
      return
    }
    this.sendFrame({
      type: FrameType.EMIT,
      codec: Codec.JSON,
      eventId: entry.id,
      payload: bytes,
    })
  }

  /** Used by the hub to forward an already-encoded frame without re-encoding per peer. */
  sendFrame(frame: Frame): void {
    this.sendEncodedFrame(encodeFrame(frame))
  }

  /** Forward an already-encoded frame. The hub encodes once and fans the same bytes out. */
  sendEncodedFrame(bytes: Uint8Array): void {
    try {
      this.#emitQueue.push(bytes)
    } catch (e) {
      if (e instanceof PeerTooSlowError) {
        this.#conn.close(CloseCode.WT_PEER_TOO_SLOW, e.message)
        return
      }
      throw e
    }
    this.#flushEmits()
  }

  sendDatagramBytes(bytes: Uint8Array): void {
    this.#dgQueue.push(bytes, this.#now())
    this.#flushDatagrams()
  }

  stats(): SessionStats {
    return { ...this.#dgQueue.stats(), staleReceived: this.#gate.staleReceived }
  }

  close(code: number, reason: string): void {
    if (this.#sweepTimer !== undefined) clearInterval(this.#sweepTimer)
    this.#conn.close(code, reason)
  }

  // ------------------------------------------------------------------ internals

  #flushEmits(): void {
    for (;;) {
      const next = this.#emitQueue.shift()
      if (next === undefined) break
      void this.#write(next)
    }
  }

  #flushDatagrams(): void {
    for (const dg of this.#dgQueue.drain(this.#now())) this.#conn.sendDatagram(dg)
  }

  #write(bytes: Uint8Array): Promise<void> {
    const w = this.#writer
    if (w === undefined) return Promise.resolve()
    this.#writeChain = this.#writeChain.then(() => w.write(bytes)).catch(() => undefined)
    return this.#writeChain
  }

  async #readEmitStream(readable: ReadableStream<Uint8Array>): Promise<void> {
    const decoder = new FrameDecoder()
    const reader = readable.getReader()
    try {
      for (;;) {
        const { value, done } = await reader.read()
        if (done) break
        if (value === undefined) continue
        for (const frame of decoder.push(value)) await this.#onFrame(frame)
      }
    } catch (e) {
      // A protocol error on the emit stream is fatal to the lane: there is one stream per
      // direction and no way to reopen it, so resetting would end stream traffic silently.
      this.#handshakeReject(e)
      this.#conn.close(CloseCode.WT_PROTOCOL_ERROR, (e as Error).message.slice(0, 1024))
    }
  }

  async #onFrame(frame: Frame): Promise<void> {
    if (frame.type === FrameType.HANDSHAKE) {
      const peer = parseHandshake(decodePayload(frame.payload))
      const n = negotiate(buildHandshake(this.#table), peer)
      this.#negotiated = n
      this.#handshakeResolve(n)
      return
    }
    if (this.#negotiated === undefined) {
      throw new TransportError(
        'WT_HANDSHAKE_INCOMPLETE',
        `a ${frame.type} frame arrived before the handshake`,
        'The handshake is frame 0 of the emit stream. Await connect() before sending.',
      )
    }
    if (frame.type === FrameType.EMIT) {
      await this.#deliver(frame.eventId, frame.payload, this.#origin)
      return
    }
    if (frame.type === FrameType.JOIN || frame.type === FrameType.LEAVE) {
      const body = decodePayload(frame.payload)
      for (const cb of this.#controlHandlers) cb(frame.type, body)
    }
  }

  #onDatagram(bytes: Uint8Array): void {
    void (async () => {
      try {
        const dg = decodeDatagram(bytes)
        if (!this.#gate.accept(dg.origin, dg.eventId, dg.sequence, this.#now())) return
        await this.#deliver(dg.eventId, dg.payload, dg.origin)
      } catch {
        // A malformed datagram is discarded. The lane already permits loss, so raising a
        // session-level fault over one bad packet would be a worse trade.
      }
    })()
  }

  async #deliver(eventId: number, payload: Uint8Array, from: number): Promise<void> {
    const entry = this.#table.byId(eventId)
    if (entry === undefined) return // peers on adjacent contracts legitimately differ
    const handlers = this.#handlers.get(entry.name)
    if (handlers === undefined || handlers.size === 0) return
    let value = decodePayload(payload)
    if (this.#validateInbound) value = await validate(entry.def.payload, value)
    for (const h of handlers) h(value, { from })
  }
}
