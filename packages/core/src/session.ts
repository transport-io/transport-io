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
  CLOSE_REASON_MAX_BYTES,
  CloseCode,
  Codec,
  EVENT_ID_NOT_APPLICABLE,
  FrameType,
  HANDSHAKE_DEADLINE_MS,
  MAX_CONCURRENT_CALL_STREAMS,
  ResetCode,
  SEQUENCE_STATE_RETENTION_MS,
} from './protocol.ts'
import { DatagramQueue, EmitQueue, PeerTooSlowError, type QueueStats } from './queue.ts'
import type { BidiStream, Connection } from './transport/types.ts'

export interface SessionStats extends QueueStats {
  readonly staleReceived: number
}

export type EventHandler = (payload: unknown, meta: { readonly from: number }) => void
export type CallHandler = (
  payload: unknown,
  ctx: { readonly signal: AbortSignal },
) => Promise<unknown>

export interface SessionOptions {
  readonly table: EventTable
  readonly origin: number
  readonly validateInbound?: boolean
  readonly now?: () => number
  readonly handshakeDeadlineMs?: number
  /**
   * How a queued datagram flush is deferred. Defaults to a microtask, which is what makes
   * the bounded ring and the TTL reachable at all: a synchronous drain on every push
   * would mean a burst never queues and neither policy ever applies. Tests inject a
   * manual scheduler to exercise both deterministically.
   */
  readonly scheduleFlush?: (flush: () => void) => void
}

/**
 * §10.2 exists so that a peer can tell a version disagreement from a framing bug. Closing
 * every refusal with 1004 made the table decorative: an implementer told "unrecoverable
 * framing violation" goes looking for a framing bug that is not there, and a peer that
 * retries on 1004 retries forever against a mismatch that will never resolve.
 */
function closeCodeFor(e: unknown): number {
  if (e instanceof TransportError) {
    if (e.code === 'WT_PROTOCOL_VERSION_MISMATCH') return CloseCode.WT_PROTOCOL_VERSION_MISMATCH
    if (e.code === 'WT_CONTRACT_MISMATCH') return CloseCode.WT_CONTRACT_MISMATCH
  }
  return CloseCode.WT_PROTOCOL_ERROR
}

/**
 * §10.2 caps the reason at 1024 **bytes**. Slicing to 1024 characters overshoots by up to
 * threefold on non-ASCII — and event names, which appear in mismatch messages, are the
 * user's own domain language. Truncated on a code-point boundary so the result is never
 * a broken surrogate pair.
 */
function closeReason(e: unknown): string {
  const message = e instanceof Error ? e.message : String(e)
  const encoder = new TextEncoder()
  if (encoder.encode(message).byteLength <= CLOSE_REASON_MAX_BYTES) return message
  let out = ''
  let bytes = 0
  for (const ch of message) {
    const size = encoder.encode(ch).byteLength
    if (bytes + size > CLOSE_REASON_MAX_BYTES) break
    out += ch
    bytes += size
  }
  return out
}

export class Session {
  readonly #conn: Connection
  readonly #table: EventTable
  readonly #origin: number
  readonly #validateInbound: boolean
  readonly #now: () => number
  readonly #deadlineMs: number
  readonly #schedule: (flush: () => void) => void
  #flushScheduled = false

  readonly #handlers = new Map<string, Set<EventHandler>>()
  readonly #gate = new SequenceGate()
  readonly #dgQueue = new DatagramQueue<Uint8Array>()
  readonly #emitQueue = new EmitQueue<Uint8Array>()
  readonly #sequences = new Map<number, number>()
  readonly #controlHandlers = new Set<(type: number, body: unknown) => void>()
  readonly #callHandlers = new Map<string, CallHandler>()
  #openCalls = 0
  #inboundCalls = 0

  #writer: WritableStreamDefaultWriter<Uint8Array> | undefined
  #writing = false
  #handshakeSent = false
  #negotiated: Negotiated | undefined
  #handshakeResolve!: (n: Negotiated) => void
  #handshakeReject!: (e: unknown) => void
  #sweepTimer: ReturnType<typeof setInterval> | undefined
  #disposed = false

  /** Resolves when both sides have exchanged a valid handshake. */
  readonly ready: Promise<Negotiated>

  constructor(conn: Connection, opts: SessionOptions) {
    this.#conn = conn
    this.#table = opts.table
    this.#origin = opts.origin
    this.#validateInbound = opts.validateInbound ?? true
    this.#now = opts.now ?? (() => Date.now())
    this.#deadlineMs = opts.handshakeDeadlineMs ?? HANDSHAKE_DEADLINE_MS
    this.#schedule = opts.scheduleFlush ?? ((flush) => queueMicrotask(flush))
    this.ready = new Promise<Negotiated>((res, rej) => {
      this.#handshakeResolve = res
      this.#handshakeReject = rej
    })
    // `ready` is rejected from the emit-stream read loop, which can reach a refusal before
    // start() has got as far as awaiting it — the peer's handshake is frame 0 and may be
    // decoded during our own `openEmitStream()`. An unobserved rejection terminates a Node
    // server by default, so it is observed here. start() still surfaces it to its caller.
    void this.ready.catch(() => undefined)
  }

  get origin(): number {
    return this.#origin
  }

  async start(): Promise<Negotiated> {
    // Whoever closes, both sides release. Registered before anything can fail, so a
    // session that dies during the handshake is cleaned up too.
    void this.#conn.closed.then(() => this.dispose())
    this.#conn.onEmitStream((readable) => void this.#readEmitStream(readable))
    this.#conn.onBidi((stream) => this.#acceptCall(stream))
    this.#conn.onDatagram((bytes) => this.#onDatagram(bytes))

    const writable = await this.#conn.openEmitStream()
    const writer = writable.getWriter()
    this.#writer = writer

    // Frame 0 of the emit stream. In-order delivery within a stream makes early traffic
    // impossible by construction, so there is no race to guard.
    await writer.write(
      encodeFrame({
        type: FrameType.HANDSHAKE,
        codec: Codec.JSON,
        eventId: EVENT_ID_NOT_APPLICABLE,
        payload: encodePayload(buildHandshake(this.#table)),
      }),
    )
    this.#handshakeSent = true
    this.#flushEmits()

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

  /** Register a responder. Only events declaring `returns` are callable. */
  handle(event: string, handler: CallHandler): () => void {
    this.#callHandlers.set(event, handler)
    return () => {
      this.#callHandlers.delete(event)
    }
  }

  /**
   * Each call opens its own bidirectional stream, so the stream IS the correlation: no
   * identifiers, no pending map, and a stalled call blocks nothing else.
   *
   * There is no default timeout. A dead peer is detected by the QUIC idle timeout, which
   * closes the session and rejects every pending call — the case a timeout is usually
   * reached for is already handled. Pass `AbortSignal.timeout(ms)` for a slow but live
   * responder.
   */
  async call(
    event: string,
    payload: unknown,
    opts?: { readonly signal?: AbortSignal },
  ): Promise<unknown> {
    const entry = this.#table.byName(event)
    if (entry === undefined) {
      throw new TransportError(
        'WT_UNKNOWN_EVENT',
        `'${event}' is not in the contract`,
        'Add it to the contract, or check the spelling.',
      )
    }
    opts?.signal?.throwIfAborted()

    if (this.#openCalls >= MAX_CONCURRENT_CALL_STREAMS) {
      throw new TransportError(
        'WT_TOO_MANY_STREAMS',
        `${this.#openCalls} call streams are already open on this session`,
        `Reduce concurrency below ${MAX_CONCURRENT_CALL_STREAMS} and retry; the session stays open.`,
      )
    }
    this.#openCalls++
    try {
      return await this.#doCall(entry.id, encodePayload(payload), opts?.signal)
    } finally {
      this.#openCalls--
    }
  }

  get openCalls(): number {
    return this.#openCalls
  }

  /**
   * The cap is a receiver-side refusal or it is nothing. `call()` declining to open a
   * 257th stream protects the peer from us; it does nothing about a peer that opens 10,000
   * — a Go implementation written from PROTOCOL.md, or a browser calling
   * `createBidirectionalStream()` directly. That is the case §10.1 code 9 exists for.
   *
   * Refused before the request is read, deliberately: the cost this bound exists to bound
   * is the decoder, the handler and the 16 MiB the decoder will buffer, all of which come
   * after the first read.
   */
  #acceptCall(stream: BidiStream): void {
    if (this.#inboundCalls >= MAX_CONCURRENT_CALL_STREAMS) {
      const refusal = new Error(`code:${ResetCode.WT_TOO_MANY_STREAMS}`)
      void stream.writable.abort(refusal).catch(() => undefined)
      void stream.readable.cancel(refusal).catch(() => undefined)
      return
    }
    this.#inboundCalls++
    void this.#serveCall(stream).finally(() => {
      this.#inboundCalls--
    })
  }

  get inboundCalls(): number {
    return this.#inboundCalls
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
    this.dispose()
    this.#conn.close(code, reason)
  }

  /**
   * Idempotent, and wired to `conn.closed` in `start()` so it cannot be forgotten.
   *
   * It was forgotten. `clearInterval` appeared in exactly one place — `close()` — and
   * neither teardown path called it: the server's `conn.closed` continuation freed the
   * origin and removed the peer, and the client's patched a snapshot. Whichever side did
   * not *initiate* the close kept a live interval whose callback closes over `this`,
   * retaining the Session, its Connection, the frame decoder, both queues, the sequence
   * gate and every handler set. At 100 sessions a second that is 360,000 unreclaimable
   * Sessions an hour, and `unref()` does nothing about it — it stops a timer holding the
   * event loop open, not holding memory.
   */
  dispose(): void {
    if (this.#disposed) return
    this.#disposed = true
    if (this.#sweepTimer !== undefined) clearInterval(this.#sweepTimer)
    this.#sweepTimer = undefined
    this.#handlers.clear()
    this.#callHandlers.clear()
    this.#controlHandlers.clear()
    this.#writer = undefined
  }

  // ------------------------------------------------------------------ calls

  async #doCall(eventId: number, body: Uint8Array, signal?: AbortSignal): Promise<unknown> {
    const stream = await this.#conn.openBidi()
    const writer = stream.writable.getWriter()
    const reader = stream.readable.getReader()

    // Abort maps to a QUIC stream reset: immediate, and costing no application message.
    // On a WebSocket this would need an app-level protocol and the peer would keep
    // sending until it heard us.
    const onAbort = (): void => {
      void writer.abort(new Error(`code:${ResetCode.WT_ABORTED}`)).catch(() => undefined)
      void reader.cancel(new Error(`code:${ResetCode.WT_ABORTED}`)).catch(() => undefined)
    }
    signal?.addEventListener('abort', onAbort, { once: true })

    try {
      await writer.write(
        encodeFrame({
          type: FrameType.CALL_REQUEST,
          codec: Codec.JSON,
          eventId,
          payload: body,
        }),
      )
      // Half-close: FIN ends the request while the read side stays open.
      await writer.close()

      const decoder = new FrameDecoder()
      const responses: Frame[] = []
      for (;;) {
        const { value, done } = await reader.read()
        if (done) break
        if (value === undefined) continue
        for (const f of decoder.push(value)) responses.push(f)
      }

      signal?.throwIfAborted()

      const error = responses.find((f) => f.type === FrameType.CALL_ERROR)
      if (error !== undefined) {
        const body_ = decodePayload(error.payload) as { code?: string; message?: string }
        throw new TransportError(
          (body_.code ?? 'WT_HANDLER_ERROR') as TransportError['code'],
          body_.message ?? 'the responder returned an error',
          'Inspect the responder. The code is the one it chose.',
        )
      }
      const first = responses.find((f) => f.type === FrameType.CALL_RESPONSE)
      if (first === undefined) {
        throw new TransportError(
          'WT_PROTOCOL_ERROR',
          'the responder closed the stream without a response frame',
          'A responder must write exactly one CALL_RESPONSE or one CALL_ERROR.',
        )
      }
      return decodePayload(first.payload)
    } finally {
      signal?.removeEventListener('abort', onAbort)
    }
  }

  async #serveCall(stream: BidiStream): Promise<void> {
    const reader = stream.readable.getReader()
    const writer = stream.writable.getWriter()
    const controller = new AbortController()
    const decoder = new FrameDecoder()
    let request: Frame | undefined

    try {
      for (;;) {
        const { value, done } = await reader.read()
        if (done) break // the initiator half-closed: the request is complete
        if (value === undefined) continue
        for (const f of decoder.push(value)) if (request === undefined) request = f
      }
    } catch {
      // A reset before the request completed is a cancellation, not a fault.
      controller.abort()
      return
    }

    // The request is fully read at this point, so nothing is watching the stream any
    // more — which is why an abort never reached the handler. The initiator's abort
    // resets its send side AND cancels its read side, and that STOP_SENDING surfaces here
    // as a rejection on our writer. Watch it, or `ctx.signal` is decoration.
    void writer.closed.catch(() => controller.abort())

    if (request === undefined || request.type !== FrameType.CALL_REQUEST) {
      await this.#failCall(writer, 'WT_PROTOCOL_ERROR', 'expected a CALL_REQUEST frame')
      return
    }
    if (this.#negotiated === undefined) {
      // A call racing the handshake resets its own stream, not the session.
      await this.#failCall(writer, 'WT_HANDSHAKE_INCOMPLETE', 'the handshake has not completed')
      return
    }
    const entry = this.#table.byId(request.eventId)
    if (entry === undefined) {
      await this.#failCall(
        writer,
        'WT_UNKNOWN_EVENT',
        `event id ${request.eventId} is not in the contract`,
      )
      return
    }
    const handler = this.#callHandlers.get(entry.name)
    if (handler === undefined) {
      await this.#failCall(
        writer,
        'WT_UNKNOWN_EVENT',
        `no handler registered for '${entry.name}'`,
      )
      return
    }

    try {
      let value = decodePayload(request.payload)
      if (this.#validateInbound) value = await validate(entry.def.payload, value)
      const result = await handler(value, { signal: controller.signal })
      await writer.write(
        encodeFrame({
          type: FrameType.CALL_RESPONSE,
          codec: Codec.JSON,
          eventId: EVENT_ID_NOT_APPLICABLE,
          payload: encodePayload(result),
        }),
      )
      await writer.close()
    } catch (e) {
      const code = e instanceof TransportError ? e.code : 'WT_HANDLER_ERROR'
      await this.#failCall(writer, code, e instanceof Error ? e.message : String(e))
    }
  }

  async #failCall(
    writer: WritableStreamDefaultWriter<Uint8Array>,
    code: string,
    message: string,
  ): Promise<void> {
    try {
      await writer.write(
        encodeFrame({
          type: FrameType.CALL_ERROR,
          codec: Codec.JSON,
          eventId: EVENT_ID_NOT_APPLICABLE,
          payload: encodePayload({ code, message: message.slice(0, 1024) }),
        }),
      )
      await writer.close()
    } catch {
      // The peer already went away; nothing left to report to.
    }
  }

  // ------------------------------------------------------------------ internals

  /**
   * Coalesced, never synchronous. A burst of emits inside one turn accumulates in the
   * bounded ring, so drop-oldest applies; and because the TTL is checked at drain, a
   * flush delayed past it discards what has gone stale rather than delivering history.
   */
  #flushDatagrams(): void {
    if (this.#flushScheduled) return
    this.#flushScheduled = true
    this.#schedule(() => {
      this.#flushScheduled = false
      for (const dg of this.#dgQueue.drain(this.#now())) this.#conn.sendDatagram(dg)
    })
  }

  /**
   * One write in flight at a time, and the frame stays in the queue until that write
   * *completes*. That is the whole fix: previously this drained the entire queue on the
   * same turn as the push and appended each frame to an unbounded promise chain, so depth
   * returned to zero after every push and `EmitQueue`'s bound could never be reached from
   * a Session. The backlog did not go away, it went somewhere that could not disconnect
   * anyone — and whose `.catch(() => undefined)` discarded every write failure on the lane
   * that advertises reliable ordered delivery.
   *
   * Nothing flushes before the handshake, so frame 0 keeps its position by construction
   * and a burst arriving mid-handshake accumulates against the bound rather than racing it.
   */
  #flushEmits(): void {
    if (this.#writing || !this.#handshakeSent) return
    const w = this.#writer
    if (w === undefined) return
    const next = this.#emitQueue.peek()
    if (next === undefined) return

    this.#writing = true
    void w.write(next).then(
      () => {
        this.#emitQueue.shift()
        this.#writing = false
        this.#flushEmits()
      },
      (e: unknown) => {
        this.#writing = false
        // §5.5: one emit stream per direction and no way to reopen it, so a fault on it is
        // fatal to the lane. Swallowing it left the lane silently dead while `getSnapshot()`
        // still reported `connected`.
        this.#conn.close(CloseCode.WT_PROTOCOL_ERROR, closeReason(e))
      },
    )
  }

  /** Frames written to the contract but not yet accepted by the transport. */
  get emitQueueDepth(): number {
    return this.#emitQueue.depth
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
      this.#conn.close(closeCodeFor(e), closeReason(e))
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
