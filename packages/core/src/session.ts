/**
 * One side of a session. Both the server's view of a peer and the client's view of the
 * server are this class - the handshake is symmetric, and so is everything after it.
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
  STREAM_CREDIT_REFILL,
  STREAM_INITIAL_CREDIT,
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

/**
 * A responder for an event declaring `yields`. The generator shape is the design: the loop
 * cannot advance until the body returns and `yield` does not resume until the write is
 * accepted, so flow control is the language's rather than a queue we would have to bound.
 */
export type StreamHandler = (
  payload: unknown,
  ctx: { readonly signal: AbortSignal },
) => AsyncIterable<unknown>

/** What `stream()` returns: iterate it, or take the whole sequence with `collect()`. */
export interface StreamResult<T> extends AsyncIterable<T> {
  collect(): Promise<T[]>
}

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
 * threefold on non-ASCII - and event names, which appear in mismatch messages, are the
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

function isAbort(e: unknown): boolean {
  const name = (e as { readonly name?: string } | null | undefined)?.name
  return name === 'AbortError' || name === 'TimeoutError'
}

function abortToTransportError(cause: unknown): TransportError {
  const timedOut =
    (cause as { readonly name?: string } | null | undefined)?.name === 'TimeoutError'
  return new TransportError(
    'WT_ABORTED',
    timedOut ? 'the call timed out before the responder answered' : 'the call was aborted',
    'The stream was reset, so the responder was told. Retry if the work is idempotent, or raise the deadline.',
  )
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
  readonly #callHandlers = new Map<string, CallHandler | StreamHandler>()
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
    // start() has got as far as awaiting it - the peer's handshake is frame 0 and may be
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

    /**
     * Armed before the stream is opened, and raced against every await that follows.
     *
     * It used to be armed *after* `openEmitStream()` and after our own handshake write, so
     * if either never settled - precisely the stalled-peer case this deadline exists for -
     * no timer was ever armed and `connect()` hung for ever. Racing `ready` instead would
     * not work: a peer whose handshake arrives before we have opened our own stream
     * resolves `ready` early, and the race would fire on success.
     */
    let onDeadline!: (e: unknown) => void
    const deadline = new Promise<never>((_, reject) => {
      onDeadline = reject
    })
    void deadline.catch(() => undefined) // observed, so it can never be an unhandled rejection

    const timer = setTimeout(() => {
      const e = new TransportError(
        'WT_HANDSHAKE_TIMEOUT',
        `no handshake within ${this.#deadlineMs}ms`,
        'The session opened but no application bytes arrived. Some browsers establish a WebTransport session and then never transmit; that combination is unsupported.',
      )
      this.#handshakeReject(e)
      this.close(CloseCode.WT_HANDSHAKE_TIMEOUT, 'handshake deadline')
      onDeadline(e)
    }, this.#deadlineMs)

    const writable = await Promise.race([this.#conn.openEmitStream(), deadline])
    const writer = writable.getWriter()
    this.#writer = writer

    // Frame 0 of the emit stream. In-order delivery within a stream makes early traffic
    // impossible by construction, so there is no race to guard.
    await Promise.race([
      writer.write(
        encodeFrame({
          type: FrameType.HANDSHAKE,
          codec: Codec.JSON,
          eventId: EVENT_ID_NOT_APPLICABLE,
          payload: encodePayload(buildHandshake(this.#table)),
        }),
      ),
      deadline,
    ])
    this.#handshakeSent = true
    this.#flushEmits()

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
    if (entry.lane === 'unreliable') {
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
  handle(event: string, handler: CallHandler | StreamHandler): () => void {
    // D1 at the registration point, which is the one that actually turns a droppable
    // message into an acknowledged one. Guarding `call()` alone would leave a responder
    // happily answering over a bidirectional stream for an event whose contract says the
    // message may be dropped.
    const entry = this.#table.byName(event)
    if (entry !== undefined && entry.lane === 'unreliable') {
      throw new TransportError(
        'WT_PROTOCOL_ERROR',
        `'${event}' is a datagram event, so it has no response path to handle`,
        'Move the event to the reliable lane and give it `returns`, or handle it with on().',
      )
    }
    this.#callHandlers.set(event, handler)
    return () => {
      this.#callHandlers.delete(event)
    }
  }

  /** Revoke a responder on this session. `Server.handle`'s disposer needs it. */
  unhandle(event: string): void {
    this.#callHandlers.delete(event)
  }

  /** True once the connection has closed and everything it held has been released. */
  get disposed(): boolean {
    return this.#disposed
  }

  /**
   * Each call opens its own bidirectional stream, so the stream IS the correlation: no
   * identifiers, no pending map, and a stalled call blocks nothing else.
   *
   * There is no default timeout. A dead peer is detected by the QUIC idle timeout, which
   * closes the session and rejects every pending call - the case a timeout is usually
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
    // An already-aborted signal must not open a stream just to tear it down.
    // §11: a peer that has detected its counterpart is gone MUST NOT reuse a stream from
    // that session. Opening a new one on a dead session is the same mistake wearing a
    // different hat - the transport may even accept it, and the call then hangs.
    if (this.#disposed) {
      throw new TransportError(
        'WT_SESSION_CLOSED',
        'the session is closed, so no call stream can be opened on it',
        'Reconnect. A reconnect is a new session and does not restore room membership (D4).',
      )
    }
    if (opts?.signal?.aborted === true) throw abortToTransportError(opts.signal.reason)
    // An event that declares no `returns` has no response to wait for. The type system
    // already excludes it from `CallableOf`; this is the same refusal for a caller that
    // reached the wire without the types - and it names the actual problem instead of
    // travelling to the responder to come back as "no handler registered", which is a
    // different fault with a different remedy.
    if (entry.def.yields !== undefined) {
      throw new TransportError(
        'WT_PROTOCOL_ERROR',
        `'${event}' declares \`yields\`, so its response is a sequence`,
        'Use stream(), or stream(...).collect() if you want the whole sequence as one value.',
      )
    }
    if (entry.lane === 'reliable' && entry.def.returns === undefined) {
      throw new TransportError(
        'WT_UNKNOWN_EVENT',
        `'${event}' declares no \`returns\`, so there is nothing to await`,
        'Add `returns` to the event in the contract, or use emit() if it is fire-and-forget.',
      )
    }
    if (entry.lane === 'unreliable') {
      throw new TransportError(
        'WT_PROTOCOL_ERROR',
        `'${event}' is a datagram event and cannot be called`,
        'A datagram may be dropped, so there is no response to await. Use emit(), or move the event to the reliable lane.',
      )
    }
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
    } catch (e) {
      // D18 removes the default call timeout on the grounds that `AbortSignal.timeout(ms)`
      // is the documented substitute, so aborting is the most-documented failure this
      // library has - and it rejected with a raw DOMException carrying no code and no
      // remedy, which the error helper printed in API.md reports as 'unknown'.
      // Read through a call so narrowing from the pre-check above does not apply: the
      // signal can abort at any point during the call, which is what it is for.
      const abortedNow = (): boolean => opts?.signal?.aborted ?? false
      throw isAbort(e) || abortedNow() ? abortToTransportError(e) : e
    } finally {
      this.#openCalls--
    }
  }

  /**
   * The streaming form of `call()`, on the same wire shape: one bidirectional stream, one
   * CALL_REQUEST, then a sequence of CALL_RESPONSE frames terminated by stream close.
   * PROTOCOL.md §6.3 always required receivers to accept a sequence, so this adds no frame
   * type and breaks no version 0 peer.
   *
   * Every guard `call()` applies is applied here, synchronously, before any stream is
   * opened. A method returning an iterable cannot report a bad event name by rejecting a
   * promise the caller has not awaited yet.
   */
  stream(
    event: string,
    payload: unknown,
    opts?: { readonly signal?: AbortSignal },
  ): StreamResult<unknown> {
    const entry = this.#table.byName(event)
    if (entry === undefined) {
      throw new TransportError(
        'WT_UNKNOWN_EVENT',
        `'${event}' is not in the contract`,
        'Add it to the contract, or check the spelling.',
      )
    }
    if (this.#disposed) {
      throw new TransportError(
        'WT_SESSION_CLOSED',
        'the session is closed, so no call stream can be opened on it',
        'Reconnect. A reconnect is a new session and does not restore room membership (D4).',
      )
    }
    if (opts?.signal?.aborted === true) throw abortToTransportError(opts.signal.reason)
    if (entry.def.yields === undefined) {
      throw new TransportError(
        'WT_UNKNOWN_EVENT',
        `'${event}' declares no \`yields\`, so it answers with one value and not a sequence`,
        'Use call(), or add `yields` to the event in the contract.',
      )
    }
    if (this.#openCalls >= MAX_CONCURRENT_CALL_STREAMS) {
      throw new TransportError(
        'WT_TOO_MANY_STREAMS',
        `${this.#openCalls} call streams are already open on this session`,
        `Reduce concurrency below ${MAX_CONCURRENT_CALL_STREAMS} and retry; the session stays open.`,
      )
    }
    return this.#doStream(entry.id, encodePayload(payload), opts?.signal)
  }

  get openCalls(): number {
    return this.#openCalls
  }

  /**
   * The cap is a receiver-side refusal or it is nothing. `call()` declining to open a
   * 257th stream protects the peer from us; it does nothing about a peer that opens 10,000
   * - a Go implementation written from PROTOCOL.md, or a browser calling
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
        this.close(CloseCode.WT_PEER_TOO_SLOW, e.message)
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

  /**
   * The only door out of a session, and every internal path now uses it.
   *
   * Guarding this method alone was not enough: four call sites reached `#conn.close()`
   * directly - the handshake deadline, the peer-too-slow bound, an emit write failure and a
   * protocol error on the read loop - so the guard covered the one path that already had
   * the fewest duplicates. A soak still produced 619,422 `close sent twice` complaints from
   * quiche after the first fix, which is what a partial guard looks like from the outside.
   */
  close(code: number, reason: string): void {
    // Idempotent in both halves. `dispose()` already was; `conn.close()` was not, so a
    // second close - a client disconnecting while the server is tearing the same session
    // down, which is ordinary - reached the transport twice. quiche logs
    // "WebTransportHttp3 close sent twice" and refuses it, which is a protocol-level
    // complaint we were generating and then ignoring.
    if (this.#disposed) return
    this.dispose()
    this.#conn.close(code, reason)
  }

  /**
   * Idempotent, and wired to `conn.closed` in `start()` so it cannot be forgotten.
   *
   * It was forgotten. `clearInterval` appeared in exactly one place - `close()` - and
   * neither teardown path called it: the server's `conn.closed` continuation freed the
   * origin and removed the peer, and the client's patched a snapshot. Whichever side did
   * not *initiate* the close kept a live interval whose callback closes over `this`,
   * retaining the Session, its Connection, the frame decoder, both queues, the sequence
   * gate and every handler set. At 100 sessions a second that is 360,000 unreclaimable
   * Sessions an hour, and `unref()` does nothing about it - it stops a timer holding the
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

  /**
   * An async generator is the implementation as well as the API, because `return()` is
   * what makes `break` mean "reset the stream". The consumer leaving the loop runs the
   * `finally` below, which resets, which the responder sees as STOP_SENDING, which fires
   * its `ctx.signal` and runs its own generator's `finally`. No cancellation message
   * exists anywhere in the protocol and none is needed.
   *
   * Receive-side flow control is the absence of a read: `reader.read()` is only reached
   * when the consumer asks for the next element, so an unconsumed stream stops reading,
   * the receive window fills, and the producer's `writer.ready` stops resolving.
   */
  #doStream(eventId: number, body: Uint8Array, signal?: AbortSignal): StreamResult<unknown> {
    const open = (): Promise<BidiStream> => this.#conn.openBidi()
    const released = (): void => {
      this.#openCalls--
    }
    this.#openCalls++

    async function* run(): AsyncGenerator<unknown> {
      const stream = await open()
      const writer = stream.writable.getWriter()
      const reader = stream.readable.getReader()
      let ended = false
      const reset = (): void => {
        const e = new Error(`code:${ResetCode.WT_ABORTED}`)
        void writer.abort(e).catch(() => undefined)
        void reader.cancel(e).catch(() => undefined)
      }
      const onAbort = (): void => reset()
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
        // No FIN here, unlike a call. The write side stays open for the life of the stream
        // because it carries the credit the responder spends. §6.2.

        let taken = 0
        let acknowledged = 0
        const payCredit = async (): Promise<void> => {
          const owed = taken - acknowledged
          if (owed < STREAM_CREDIT_REFILL) return
          acknowledged = taken
          await writer.write(
            encodeFrame({
              type: FrameType.CALL_CREDIT,
              codec: Codec.JSON,
              eventId: EVENT_ID_NOT_APPLICABLE,
              payload: encodePayload({ credit: owed }),
            }),
          )
        }

        const decoder = new FrameDecoder()
        for (;;) {
          const { value, done } = await reader.read()
          if (done) break
          if (value === undefined) continue
          for (const f of decoder.push(value)) {
            if (f.type === FrameType.CALL_ERROR) {
              const b = decodePayload(f.payload) as { code?: string; message?: string }
              throw new TransportError(
                (b.code ?? 'WT_HANDLER_ERROR') as TransportError['code'],
                b.message ?? 'the responder returned an error',
                "Elements yielded before the error were delivered. The code is the responder's.",
              )
            }
            if (f.type !== FrameType.CALL_RESPONSE) continue
            yield decodePayload(f.payload)
            // Reached only when the consumer asks for the next element, which is what
            // makes this an acknowledgement of consumption rather than of arrival.
            taken++
            await payCredit()
          }
        }
        signal?.throwIfAborted()
        ended = true
        await writer.close()
      } catch (e) {
        // Same conversion `call()` makes. Aborting is the most-documented failure this
        // library has and it must not arrive as a DOMException with no code and no remedy.
        throw isAbort(e) || signal?.aborted === true ? abortToTransportError(e) : e
      } finally {
        signal?.removeEventListener('abort', onAbort)
        // Not ended means the consumer broke, threw, or was aborted. Either way the
        // responder is still producing and has to be told.
        if (!ended) reset()
        released()
      }
    }

    const gen = run()
    return {
      [Symbol.asyncIterator]: () => gen,
      async collect(): Promise<unknown[]> {
        const out: unknown[] = []
        for await (const v of gen) out.push(v)
        return out
      },
    }
  }

  async #serveCall(stream: BidiStream): Promise<void> {
    const reader = stream.readable.getReader()
    const writer = stream.writable.getWriter()
    const controller = new AbortController()
    const decoder = new FrameDecoder()
    let request: Frame | undefined

    let streaming = false
    try {
      for (;;) {
        const { value, done } = await reader.read()
        if (done) break // the initiator half-closed: the request is complete
        if (value === undefined) continue
        for (const f of decoder.push(value)) if (request === undefined) request = f
        // A streaming initiator never sends FIN: its write side carries credit for the
        // life of the stream. Waiting for `done` here would hang for ever.
        if (
          request !== undefined &&
          this.#table.byId(request.eventId)?.def.yields !== undefined
        ) {
          streaming = true
          break
        }
      }
    } catch {
      // A reset before the request completed is a cancellation, not a fault.
      controller.abort()
      return
    }

    // The request is fully read at this point, so nothing is watching the stream any
    // more - which is why an abort never reached the handler. The initiator's abort
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
    if (entry.lane === 'unreliable') {
      // A peer is not bound by our types. A second implementation written from
      // PROTOCOL.md can open a bidirectional stream for any event id it likes, and
      // answering one for a datagram event would silently upgrade a droppable message to a
      // guaranteed one on this side of the wire.
      await this.#failCall(
        writer,
        'WT_PROTOCOL_ERROR',
        `event '${entry.name}' is on the unreliable lane and is not callable`,
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

      if (entry.def.yields !== undefined) {
        await this.#serveStream(
          handler as StreamHandler,
          value,
          entry.name,
          writer,
          controller,
          {
            readNext: async () => {
              const r = await reader.read()
              return r.done ? undefined : (r.value as Uint8Array)
            },
            decoder,
            streaming,
          },
        )
        return
      }

      const result = await (handler as CallHandler)(value, { signal: controller.signal })
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

  /**
   * One yielded element is one CALL_RESPONSE frame. No coalescing: batching would mean a
   * buffer and a timer, which is the thing the generator shape exists to avoid. A caller
   * who wants fewer, larger frames batches inside their own generator and pays the 12-byte
   * frame overhead once per batch instead of once per element.
   *
   * `writer.ready` before every write is where the bound lives. If it resolves
   * unconditionally the language is not holding anything back and this is a lie, which is
   * why the number is measured rather than asserted (D77).
   */
  async #serveStream(
    handler: StreamHandler,
    payload: unknown,
    name: string,
    writer: WritableStreamDefaultWriter<Uint8Array>,
    controller: AbortController,
    inbound: {
      // A closure rather than the reader itself: the Node and DOM spellings of
      // `ReadableStreamDefaultReader` differ, and this only ever needs the next chunk.
      readNext: () => Promise<Uint8Array | undefined>
      decoder: FrameDecoder
      streaming: boolean
    },
  ): Promise<void> {
    const produced = handler(payload, { signal: controller.signal })
    if (
      produced === null ||
      typeof produced !== 'object' ||
      !(Symbol.asyncIterator in produced)
    ) {
      await this.#failCall(
        writer,
        'WT_HANDLER_ERROR',
        `the handler for '${name}' declares \`yields\` but did not return an async iterable`,
      )
      return
    }

    // The window, and the loop that refills it. `writer.ready` is not load-bearing here:
    // it resolves unconditionally on the reference binding, which is the whole reason this
    // accounting exists (D93). It is still awaited, because a transport that does honour it
    // should be allowed to.
    let credit = STREAM_INITIAL_CREDIT
    let wake: (() => void) | undefined
    const nudge = (): void => {
      wake?.()
      wake = undefined
    }
    controller.signal.addEventListener('abort', nudge, { once: true })

    /**
     * Cancellation has to be able to interrupt a write, not only the credit wait.
     *
     * `writer.abort()` cannot do it: per the streams contract an abort request queues
     * behind the write already in flight, so a producer parked in `writer.write()` for a
     * consumer that has stopped reading stays parked, and its generator's `finally` never
     * runs. Measured on the loopback transport, which is the honest one here. So the write
     * is raced against the signal instead: the frame may still be in the transport's hands
     * afterwards, which is fine, because the stream is being torn down either way.
     */
    let abortWaiter: (() => void) | undefined
    const aborted = new Promise<never>((_, rej) => {
      abortWaiter = (): void => rej(abortToTransportError(controller.signal.reason))
      controller.signal.addEventListener('abort', abortWaiter, { once: true })
    })
    void aborted.catch(() => undefined)
    if (inbound.streaming) {
      void (async () => {
        try {
          for (;;) {
            const chunk = await inbound.readNext()
            if (chunk === undefined) break
            for (const f of inbound.decoder.push(chunk)) {
              if (f.type !== FrameType.CALL_CREDIT) continue
              const b = decodePayload(f.payload) as { credit?: number }
              if (typeof b.credit === 'number' && b.credit > 0) {
                credit += b.credit
                nudge()
              }
            }
          }
        } catch {
          // The stream was reset. The write path sees it too and aborts the generator.
        }
        controller.abort()
      })()
    }

    const it = produced[Symbol.asyncIterator]()
    try {
      for (;;) {
        const next = await it.next()
        if (next.done === true) break
        if (controller.signal.aborted) break
        // The initiator half-closed before we ever started: it is a `returns`-shaped peer,
        // or one that has given up. Either way no credit is coming, and the alternative to
        // stopping is holding a generator and a stream slot open until the session dies.
        if (!inbound.streaming) {
          controller.abort()
          break
        }
        while (credit <= 0 && !controller.signal.aborted) {
          await new Promise<void>((res) => {
            wake = res
          })
        }
        if (controller.signal.aborted) break
        credit--
        await writer.ready
        await Promise.race([
          writer.write(
            encodeFrame({
              type: FrameType.CALL_RESPONSE,
              codec: Codec.JSON,
              eventId: EVENT_ID_NOT_APPLICABLE,
              payload: encodePayload(next.value),
            }),
          ),
          aborted,
        ])
      }
      if (!controller.signal.aborted) await writer.close()
    } catch (e) {
      // A reset arriving mid-production is a cancellation, not a fault, and there is
      // nothing left to write a CALL_ERROR onto anyway.
      if (!controller.signal.aborted) {
        const code = e instanceof TransportError ? e.code : 'WT_HANDLER_ERROR'
        await this.#failCall(writer, code, e instanceof Error ? e.message : String(e))
      }
    } finally {
      controller.signal.removeEventListener('abort', nudge)
      if (abortWaiter !== undefined) controller.signal.removeEventListener('abort', abortWaiter)
      // The reason this file's first test exists. Without it a handler's `finally` never
      // runs on cancellation, and every resource it holds open stays open.
      await it.return?.(undefined).catch?.(() => undefined)
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
   * *completes*. Previously this drained the entire queue on the
   * same turn as the push and appended each frame to an unbounded promise chain, so depth
   * returned to zero after every push and `EmitQueue`'s bound could never be reached from
   * a Session. The backlog did not go away, it went somewhere that could not disconnect
   * anyone - and whose `.catch(() => undefined)` discarded every write failure on the lane
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
        this.close(CloseCode.WT_PROTOCOL_ERROR, closeReason(e))
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
      this.close(closeCodeFor(e), closeReason(e))
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
    // PROTOCOL.md §7 and ADR 0009: a datagram before the handshake is discarded silently.
    // The reliable lane has had this guard all along; the unreliable lane had none, so an
    // early packet was decoded and handed to the application for a session whose contract
    // had not been agreed. A second implementation drops it, and this one rendered it.
    if (this.#negotiated === undefined) return
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
