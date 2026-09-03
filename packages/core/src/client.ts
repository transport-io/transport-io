/**
 * Client surface.
 *
 * Constructible without I/O: nothing here touches `window` or `WebTransport` at module
 * scope, so importing this on a server - which Next.js will do - is safe. Feature
 * detection happens inside connect().
 */
import {
  type AnyMap,
  buildEventTable,
  type CallableOf,
  type Contract,
  type Registered,
  type StreamableOf,
} from './contract.ts'
import { TransportError } from './errors.ts'
import { CloseCode, FrameType } from './protocol.ts'
import { Session, type SessionStats, type StreamResult } from './session.ts'
import type { Connection } from './transport/types.ts'

export type Status = 'idle' | 'connecting' | 'connected' | 'closing' | 'closed'

export interface ClientState {
  readonly status: Status
  readonly sessionId: string | null
  readonly rooms: readonly string[]
  readonly lastError: TransportError | null
}

export interface ClientOptions<C extends Contract = Contract> {
  /**
   * How long to wait for the peer's handshake before giving up. The deadline covers
   * opening the emit stream as well as the exchange, so a transport that never opens one
   * fails here rather than hanging.
   */
  readonly handshakeDeadlineMs?: number

  readonly contract: C
  /** Supplied by the transport seam, so this class never imports a transport. */
  readonly connect: () => Promise<Connection>
  readonly validateInbound?: boolean
  /** Clients stamp their own origin on outbound datagrams. */
  readonly origin?: number
  /** Test seam: how a queued datagram flush is deferred. Defaults to a microtask. */
  readonly scheduleFlush?: (flush: () => void) => void
  /** Test seam: the clock the TTL is measured against. Defaults to `Date.now`. */
  readonly now?: () => number
}

export class Client<M extends AnyMap = Registered> {
  readonly #opts: ClientOptions
  readonly #listeners = new Set<() => void>()
  readonly #handlers = new Map<string, Set<(payload: unknown) => void>>()
  #session: Session | undefined
  /**
   * Bumped by every `disconnect`, so a connect already in flight can tell it was superseded.
   *
   * Without it, `disconnect()` during `await connect()` did nothing to the attempt: the
   * session it eventually produced was adopted anyway and had every stored handler
   * registered on it, so two sessions dispatched to one handler and every event arrived
   * twice. React StrictMode does exactly that on each mount in development, and the loopback
   * transport resolves fast enough to hide it.
   */
  #generation = 0
  #snapshot: ClientState = Object.freeze({
    status: 'idle',
    sessionId: null,
    rooms: [],
    lastError: null,
  })
  #refs = 0
  #connecting: Promise<void> | undefined

  constructor(opts: ClientOptions) {
    this.#opts = opts
  }

  /**
   * Referentially stable until something actually changes. Returning a freshly built
   * object on each call makes useSyncExternalStore re-render forever, which is the single
   * most common way this shape is implemented incorrectly.
   */
  getSnapshot(): ClientState {
    return this.#snapshot
  }

  subscribe(listener: () => void): () => void {
    this.#listeners.add(listener)
    return () => {
      this.#listeners.delete(listener)
    }
  }

  /** Idempotent and refcounted: two components sharing a client cannot tear each other
   *  down, which matters because React StrictMode mounts twice in development. */
  async connect(): Promise<void> {
    this.#refs++
    if (this.#connecting === undefined) this.#connecting = this.#doConnect()
    try {
      await this.#connecting
    } catch (e) {
      this.#connecting = undefined
      throw e
    }
  }

  disconnect(): void {
    this.#refs = Math.max(0, this.#refs - 1)
    if (this.#refs > 0) return
    this.#generation++
    this.#patch({ status: 'closing' })
    const closing = this.#session
    closing?.close(CloseCode.WT_NO_ERROR, 'client disconnect')
    /**
     * Disposed as well as closed, because closing is not immediate on a real transport.
     *
     * `on()` registers a handler on whatever session is current, and `connect()` registers
     * every stored handler on the new one. Nothing removed them from the old session, so
     * during a reconnect - which is exactly what React StrictMode does on every mount in
     * development - both sessions dispatched to the same handler and every event arrived
     * twice. Over the loopback transport the close is fast enough to hide it; over QUIC it
     * is not, which is why this was found in a browser and not in a unit test.
     */
    closing?.dispose()
    this.#session = undefined
    this.#connecting = undefined
    this.#patch({ status: 'closed', sessionId: null, rooms: [] })
  }

  /** The lane comes from the contract, never from this call site. */
  emit<K extends keyof M & string>(event: K, payload: M[K]['payload']): void {
    this.#requireSession().emit(event, payload)
  }

  on<K extends keyof M & string>(
    event: K,
    handler: (payload: M[K]['payload']) => void,
  ): () => void {
    let set = this.#handlers.get(event)
    if (set === undefined) {
      set = new Set()
      this.#handlers.set(event, set)
    }
    set.add(handler as (p: unknown) => void)
    const off = this.#session?.on(event, (p) => handler(p as M[K]['payload']))
    return () => {
      set.delete(handler as (p: unknown) => void)
      off?.()
    }
  }

  /** Available only on events declaring `returns`. Aborting resets the QUIC stream. */
  async call<K extends CallableOf<M> & string>(
    event: K,
    payload: M[K]['payload'],
    options?: { readonly signal?: AbortSignal },
  ): Promise<M[K]['returns']> {
    return (await this.#requireSession().call(event, payload, options)) as M[K]['returns']
  }

  /**
   * Available only on events declaring `yields`. Iterate it to the end, or `.toArray()` the
   * whole sequence. Leaving the loop early, by `break`, `return` or `throw`, resets the QUIC
   * stream, and that reset is what fires the responder's `ctx.signal`. `cancel()` does the
   * same from outside the loop, and an `AbortSignal` in the options does it on a deadline.
   */
  stream<K extends StreamableOf<M> & string>(
    event: K,
    payload: M[K]['payload'],
    options?: { readonly signal?: AbortSignal },
  ): StreamResult<M[K]['yields']> {
    return this.#requireSession().stream(event, payload, options) as StreamResult<
      M[K]['yields']
    >
  }

  stats(): SessionStats | undefined {
    return this.#session?.stats()
  }

  async #doConnect(): Promise<void> {
    this.#patch({ status: 'connecting', lastError: null })
    const generation = this.#generation
    try {
      const table = await buildEventTable(this.#opts.contract)
      const conn = await this.#opts.connect()

      // Chrome implements neither `requireUnreliable` nor `reliability`, so `undefined`
      // must pass or every session on the dominant browser would be refused. Only an
      // explicit reliable-only would misreport what the unreliable lane does.
      if (conn.reliability() === 'reliable-only') {
        // §10.2 code 1006. Throwing without closing left the peer holding a session this
        // side had already abandoned, with nothing on the wire to say why.
        conn.close(CloseCode.WT_RELIABILITY_REFUSED, 'reliable-only transport refused')
        throw new TransportError(
          'WT_RELIABILITY_REFUSED',
          'the session negotiated reliable-only transport',
          'The unreliable lane would silently become reliable and ordered. This library refuses rather than lie about your data.',
        )
      }

      const session = new Session(conn, {
        table,
        origin: this.#opts.origin ?? 0x80000001,
        ...(this.#opts.validateInbound === undefined
          ? {}
          : { validateInbound: this.#opts.validateInbound }),
        ...(this.#opts.handshakeDeadlineMs === undefined
          ? {}
          : { handshakeDeadlineMs: this.#opts.handshakeDeadlineMs }),
        ...(this.#opts.scheduleFlush === undefined
          ? {}
          : { scheduleFlush: this.#opts.scheduleFlush }),
        ...(this.#opts.now === undefined ? {} : { now: this.#opts.now }),
      })
      // Superseded while the transport was being established. Adopting this session would
      // register every handler on it alongside the one the newer connect built.
      if (generation !== this.#generation) {
        session.dispose()
        conn.close(CloseCode.WT_NO_ERROR, 'connect superseded')
        return
      }
      this.#session = session

      for (const [event, handlers] of this.#handlers) {
        for (const h of handlers) session.on(event, (p) => h(p))
      }
      session.onControl((type, body) => this.#onMembership(type, body))

      await session.start()
      this.#patch({ status: 'connected', sessionId: `s-${session.origin}` })

      void conn.closed.then(() => {
        this.#patch({ status: 'closed', sessionId: null, rooms: [] })
      })
    } catch (e) {
      const err =
        e instanceof TransportError
          ? e
          : new TransportError('WT_SESSION_CLOSED', String(e), 'Retry the connection.')
      this.#patch({ status: 'closed', lastError: err })
      throw err
    }
  }

  /** Rooms are server-authoritative, so membership only ever arrives as a notification. */
  #onMembership(type: number, body: unknown): void {
    const room = (body as { room?: unknown }).room
    if (typeof room !== 'string') return
    const rooms = new Set(this.#snapshot.rooms)
    if (type === FrameType.JOIN) rooms.add(room)
    else rooms.delete(room)
    this.#patch({ rooms: [...rooms].sort() })
  }

  #requireSession(): Session {
    if (this.#session === undefined) {
      throw new TransportError(
        'WT_SESSION_CLOSED',
        'not connected',
        'Await connect() before emitting.',
      )
    }
    return this.#session
  }

  #patch(next: Partial<ClientState>): void {
    this.#snapshot = Object.freeze({ ...this.#snapshot, ...next })
    for (const l of this.#listeners) l()
  }
}
