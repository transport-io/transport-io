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
  type FallbackReady,
  type ReceivedBy,
  type Registered,
  type SentBy,
  type StreamableOf,
} from './contract.ts'
import { errorForClose, RefusedError, TransportError } from './errors.ts'
import {
  composeTap,
  type FrameObserver,
  type ObserveOptions,
  type Subscriber,
} from './observe.ts'
import { CloseCode, FrameType } from './protocol.ts'
import { Session, type SessionStats, type StreamResult } from './session.ts'
import { OwnedTimers } from './timers.ts'
import type { Connection, Transport } from './transport/types.ts'

export type Status = 'idle' | 'connecting' | 'connected' | 'closing' | 'closed'

/**
 * Why the current session is on a fallback transport rather than on WebTransport.
 * `unsupported`: the runtime has no WebTransport it can use against this server, either none
 * at all or one that connects and then never sends, which is Safari (D128). `unreachable`:
 * the WebTransport handshake failed and the WebSocket connected.
 */
export type FallbackReason = 'unsupported' | 'unreachable'

/**
 * The server's `authorize` refused this client, and why: what `refuse(reason)` was given, or
 * `'refused'` where `authorize` returned `null`.
 */
export interface Refused {
  readonly reason: string
}

export interface ClientState {
  readonly status: Status
  readonly sessionId: string | null
  readonly rooms: readonly string[]
  readonly lastError: TransportError | null
  /**
   * Set when the server refused this client at `authorize`, beside a `status` of `closed`.
   * A refusal is final: the same request would be refused again, so a client that reconnects
   * on its own has stopped, and nothing happens until the application calls `disconnect()`
   * and `connect()` with a credential that will pass. `null` otherwise, and cleared when the
   * next attempt starts.
   */
  readonly refused: Refused | null
  /** What carries the current session. `null` until connected. */
  readonly transport: Transport | null
  /**
   * Why the current session is a fallback: the runtime has no WebTransport it can use, or
   * the WebTransport handshake failed and the WebSocket connected. `null` on a native session.
   */
  readonly fallbackReason: FallbackReason | null
}

/**
 * The waits between attempts, when a client reconnects on its own. The wait after a session
 * closes is `minMs`, doubled on each failed attempt up to `maxMs`, and randomised between
 * half of that and all of it, so a fleet that lost one server does not return as one wave.
 */
export interface ReconnectOptions {
  readonly minMs: number
  readonly maxMs: number
}

export interface ClientOptions<C extends Contract = Contract> {
  /**
   * How long to wait for the peer's handshake before giving up. The deadline covers
   * opening the emit stream as well as the exchange, so a transport that never opens one
   * fails here rather than hanging.
   */
  readonly handshakeDeadlineMs?: number

  /**
   * Reconnect on its own after a connected session closes. Off unless given. Every attempt
   * starts from the native connector again, and every session it produces runs `onSession`.
   * The first `connect()` is not retried: it resolves or rejects as it always did, and the
   * retrying starts once a session has been had. `disconnect()` stops it.
   */
  readonly reconnect?: ReconnectOptions

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
    refused: null,
    transport: null,
    fallbackReason: null,
  })
  #refs = 0
  #connecting: Promise<void> | undefined
  readonly #timers = new OwnedTimers()
  /** Failed attempts since the last connected session, which sets the next wait. */
  #attempt = 0
  readonly #onSession = new Set<(state: ClientState) => void>()
  readonly #observers = new Set<Subscriber>()
  /** Sessions this client has adopted, which is what numbers them for an observer. */
  #sessions = 0

  constructor(opts: ClientOptions) {
    this.#opts = opts
  }

  /**
   * Runs once for every session this client gets, with the snapshot as it connected: the
   * first, and each one a reconnect produces. A reconnect is a new session (D4), so this is
   * where rooms are rejoined and what was missed is fetched. Returns the unsubscribe.
   */
  onSession(cb: (state: ClientState) => void): () => void {
    this.#onSession.add(cb)
    return () => {
      this.#onSession.delete(cb)
    }
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
    this.#connecting ??= this.#doConnect()
    const attempt = this.#connecting
    try {
      await attempt
    } catch (e) {
      // Only this attempt's: after `disconnect()` and a newer `connect()`, clearing it would
      // let a third `connect()` start an attempt beside the one in flight.
      if (this.#connecting === attempt) this.#connecting = undefined
      throw e
    }
  }

  disconnect(): void {
    this.#refs = Math.max(0, this.#refs - 1)
    if (this.#refs > 0) return
    this.#generation++
    // A reconnect that was waiting is off: the application said stop.
    this.#timers.clearAll()
    this.#attempt = 0
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
    this.#patch({
      status: 'closed',
      sessionId: null,
      rooms: [],
      transport: null,
      fallbackReason: null,
    })
  }

  /** The lane comes from the contract, never from this call site. */
  emit<K extends SentBy<M, 'client'> & string>(event: K, payload: M[K]['payload']): void {
    this.#requireSession().emit(event, payload)
  }

  on<K extends ReceivedBy<M, 'client'> & string>(
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

  /**
   * One record for every frame in and out, every call stream opening and closing, and every
   * drop `stats()` counts, on this session and on each one a reconnect produces. Off unless
   * something subscribes: a client nobody observes builds no records. A record holds no
   * payload, and `preview: true` adds the first bytes of each as a string. Returns the
   * unsubscribe.
   */
  observe(observer: FrameObserver, options?: ObserveOptions): () => void {
    const subscriber = { observer, preview: options?.preview === true }
    this.#observers.add(subscriber)
    this.#tap()
    return () => {
      this.#observers.delete(subscriber)
      this.#tap()
    }
  }

  /** Hands the current session its observer, composed from whoever subscribes now. */
  #tap(): void {
    this.#session?.observe(composeTap([...this.#observers], this.#sessions))
  }

  async #doConnect(): Promise<void> {
    const generation = this.#generation
    // Everything from here to the handshake is inside the `try`, this first write included: a
    // subscriber that throws on it left the status at `connecting` with no `lastError`.
    try {
      this.#patch({ status: 'connecting', lastError: null, refused: null })
      const table = await buildEventTable(this.#opts.contract)
      const fallback = fallbacks.get(this)

      let native: Connection
      try {
        native = await this.#opts.connect()
      } catch (e) {
        // No WebTransport in this runtime: the fallback carries the session. A WebTransport
        // handshake that failed: the fallback is dialled, because a connector is a closure
        // and the WebSocket handshake is the one fact this client can obtain about whether
        // the server is up over TCP (D125). If that fails too, the WebTransport error is the
        // one thrown: it names the primary transport, and its message says what its probe
        // found. Every other failure is thrown as it is, because a certificate past its
        // validity or a dev connector outside the dev command is configuration, not a path
        // to route around.
        if (fallback === undefined) throw e
        const reason = fallbackReasonFor(e)
        if (reason === undefined) throw e
        if (reason === 'unsupported') {
          await this.#start(await fallback(), reason, generation, table)
          return
        }
        let conn: Connection
        try {
          conn = await fallback()
        } catch {
          throw e
        }
        await this.#start(conn, reason, generation, table)
        return
      }

      try {
        await this.#start(native, null, generation, table)
      } catch (e) {
        // The transport connected and then nothing arrived before the application
        // handshake. A live peer is never quiet there, since frame 0 is sent without
        // waiting, so this is a peer that cannot send: Safari against this server (D128).
        // The session that timed out closed itself; the fallback gets a session of its own.
        // If that fails too, the WebTransport error is the one thrown.
        if (
          fallback === undefined ||
          native.kind() !== 'webtransport' ||
          !isHandshakeTimeout(e)
        ) {
          throw e
        }
        try {
          await this.#start(await fallback(), 'unsupported', generation, table)
        } catch {
          throw e
        }
      }
    } catch (e) {
      // Anything that is not a `TransportError` is not a statement about the transport, so
      // the remedy says where the real error is rather than what to do about it (D156).
      const err =
        e instanceof TransportError
          ? e
          : new TransportError(
              'WT_SESSION_CLOSED',
              String(e),
              'Read `cause`, which is what was thrown.',
              e,
            )
      // Superseded by `disconnect()`: the snapshot is the newer state's, and this attempt's
      // failure is its own caller's rejection and nothing more.
      if (generation === this.#generation) {
        this.#patch({ status: 'closed', lastError: err, refused: refusedBy(err) })
      }
      throw err
    }
  }

  /**
   * One session over one connection: refused if the transport is reliable-only, started,
   * and adopted unless a newer connect superseded it while the transport was being
   * established. `transport` reaches the snapshot only here, once the handshake completed,
   * so a connection whose session never handshook was never the client's transport.
   */
  async #start(
    conn: Connection,
    fallbackReason: FallbackReason | null,
    generation: number,
    table: Awaited<ReturnType<typeof buildEventTable>>,
  ): Promise<void> {
    // Chrome implements neither `requireUnreliable` nor `reliability`, so `undefined`
    // must pass or every session on the dominant browser would be refused. Only an
    // explicit reliable-only would misreport what the unreliable lane does. A fallback
    // transport is reliable-only by definition and is judged by the session instead,
    // against the contract's declarations (D121).
    if (conn.kind() === 'webtransport' && conn.reliability() === 'reliable-only') {
      // §10.2 code 1006. Throwing without closing left the peer holding a session this
      // side had already abandoned, with nothing on the wire to say why.
      conn.close(CloseCode.WT_RELIABILITY_REFUSED, 'reliable-only transport refused')
      throw new TransportError(
        'WT_RELIABILITY_REFUSED',
        'the session negotiated reliable-only transport',
        'The unreliable lane would silently become reliable and ordered. This library refuses rather than lie about your data.',
      )
    }

    // The client's options pass straight through: the ones a session also takes,
    // `validateInbound`, `handshakeDeadlineMs`, `scheduleFlush` and `now`, have the same names
    // and meanings, the session reads each with `??` so an absent one and an undefined one
    // are the same, and it reads nothing else of what is spread in.
    const session = new Session(conn, {
      ...this.#opts,
      table,
      origin: this.#opts.origin ?? 0x80000001,
      side: 'client',
      holdDelivery: true,
    })
    // Superseded while the transport was being established. Adopting this session would
    // register every handler on it alongside the one the newer connect built.
    if (generation !== this.#generation) {
      session.dispose()
      conn.close(CloseCode.WT_NO_ERROR, 'connect superseded')
      return
    }
    this.#session = session
    this.#sessions++
    this.#tap()

    for (const [event, handlers] of this.#handlers) {
      for (const h of handlers) session.on(event, (p) => h(p))
    }
    session.onControl((type, body) => this.#onMembership(type, body))

    try {
      await session.start()
    } catch (e) {
      // A session that never started is nobody's session. Left in place it answered `emit`
      // by dropping, where a client with no session throws. `close` is idempotent, so a
      // session the peer or the deadline already closed is not closed twice.
      session.close(CloseCode.WT_NO_ERROR, 'handshake failed')
      if (this.#session === session) this.#session = undefined
      throw e
    }
    this.#attempt = 0
    this.#patch({
      status: 'connected',
      sessionId: `s-${session.origin}`,
      transport: conn.kind(),
      fallbackReason,
    })
    // Nothing from this session reaches a handler until every `onSession` callback has
    // returned: the session holds what the peer sent after its handshake. Released in a
    // `finally`, so a callback that throws does not leave the session holding for ever.
    try {
      for (const cb of this.#onSession) cb(this.#snapshot)
    } finally {
      session.release()
    }

    void conn.closed.then((info) => {
      // Superseded by a disconnect or a newer connect: that path patched its own state.
      if (generation !== this.#generation) return
      this.#session = undefined
      this.#connecting = undefined
      // A close code that is an error says why the session ended. A server may close a live
      // session as `WT_UNAUTHORIZED`, a token that expired, and that is a refusal like one
      // at the door.
      const err = errorForClose(info.code, info.reason) ?? null
      const refused = refusedBy(err)
      this.#patch({
        status: 'closed',
        sessionId: null,
        rooms: [],
        transport: null,
        fallbackReason: null,
        lastError: err,
        refused,
      })
      if (refused !== null) return
      if (this.#opts.reconnect !== undefined && this.#refs > 0) this.#scheduleReconnect()
    })
  }

  /**
   * One attempt after a wait, and another wait after a failed one. The guard against two
   * attempts overlapping is `#connecting`, the same one `connect()` uses, and the guard
   * against reconnecting after `disconnect()` is the generation, the same one a superseded
   * connect uses.
   */
  #scheduleReconnect(): void {
    const reconnect = this.#opts.reconnect
    if (reconnect === undefined) return
    const base = Math.min(reconnect.maxMs, reconnect.minMs * 2 ** this.#attempt)
    const delay = Math.round(base * (0.5 + Math.random() * 0.5))
    this.#attempt++
    const generation = this.#generation
    this.#timers.after(delay, () => {
      if (generation !== this.#generation || this.#refs === 0) return
      if (this.#connecting !== undefined) return
      const attempt = this.#doConnect()
      this.#connecting = attempt
      attempt.catch((e: unknown) => {
        if (this.#connecting === attempt) this.#connecting = undefined
        // A refusal is final. The token was never going to become valid by waiting, and
        // retrying it is a client that says "offline, retrying" for ever.
        if (e instanceof RefusedError) return
        if (generation === this.#generation && this.#refs > 0) this.#scheduleReconnect()
      })
    })
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

/**
 * The fallback connector a client was built with, keyed by the client and readable only from
 * this module. `ClientOptions` deliberately has no `fallback` field: putting one there would
 * let `new Client(...)` take a fallback without passing the gate below.
 */
const fallbacks = new WeakMap<object, () => Promise<Connection>>()

function refusedBy(e: TransportError | null): Refused | null {
  return e instanceof RefusedError ? Object.freeze({ reason: e.reason }) : null
}

function fallbackReasonFor(e: unknown): FallbackReason | undefined {
  if (!(e instanceof TransportError)) return undefined
  if (e.code === 'WT_NO_SUPPORT') return 'unsupported'
  if (e.code === 'WT_UDP_UNREACHABLE' || e.code === 'WT_HANDSHAKE_FAILED') return 'unreachable'
  return undefined
}

function isHandshakeTimeout(e: unknown): boolean {
  return e instanceof TransportError && e.code === 'WT_HANDSHAKE_TIMEOUT'
}

/** The lanes only a native session carries. */
export type NativeLanes<M extends AnyMap> = Pick<Client<M>, 'call' | 'stream'>

/**
 * A client that may be on a fallback transport, so `call()` and `stream()` are not its
 * methods: they live on `native`, which is `null` while the session is a fallback. The
 * compiler makes the check unavoidable; nothing about it is discovered at runtime.
 */
export type FallbackClient<M extends AnyMap> = Omit<Client<M>, 'call' | 'stream'> & {
  /** `call()` and `stream()`, on a native session. `null` on a fallback, or when not connected. */
  readonly native: NativeLanes<M> | null
}

/**
 * A client with a second transport behind the first (D121).
 *
 * The native connector is tried first, every time. The fallback is used when the runtime
 * has no WebTransport, when the WebTransport handshake fails and the WebSocket connects, and
 * when the WebTransport session connects and then sends nothing before the application
 * handshake (D128); the snapshot says which. The type argument is the gate: `FallbackReady<M>` is `unknown`
 * when every unreliable event in the map declares a fallback, and otherwise a required
 * property naming the event that has not, so this call fails to compile rather than an
 * emit failing in production.
 */
export function withFallback<M extends AnyMap = Registered>(
  options: ClientOptions & FallbackReady<M> & { readonly fallback: () => Promise<Connection> },
): FallbackClient<M> {
  const client = new Client<M>(options)
  fallbacks.set(client, options.fallback)
  Object.defineProperty(client, 'native', {
    enumerable: true,
    get: (): NativeLanes<M> | null =>
      client.getSnapshot().transport === 'webtransport' ? client : null,
  })
  return client as unknown as FallbackClient<M>
}
