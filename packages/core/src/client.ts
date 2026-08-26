/**
 * Client surface.
 *
 * Constructible without I/O: nothing here touches `window` or `WebTransport` at module
 * scope, so importing this on a server — which Next.js will do — is safe. Feature
 * detection happens inside connect().
 */
import { type AnyMap, buildEventTable, type CallableOf, type Contract } from './contract.ts'
import { TransportError } from './errors.ts'
import { CloseCode, FrameType } from './protocol.ts'
import { Session, type SessionStats } from './session.ts'
import type { Connection } from './transport/types.ts'

export type Status = 'idle' | 'connecting' | 'connected' | 'closing' | 'closed'

export interface ClientState {
  readonly status: Status
  readonly sessionId: string | null
  readonly rooms: readonly string[]
  readonly lastError: TransportError | null
}

export interface ClientOptions<C extends Contract = Contract> {
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

export class Client<M extends AnyMap = AnyMap> {
  readonly #opts: ClientOptions
  readonly #listeners = new Set<() => void>()
  readonly #handlers = new Map<string, Set<(payload: unknown) => void>>()
  #session: Session | undefined
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
    this.#patch({ status: 'closing' })
    this.#session?.close(CloseCode.WT_NO_ERROR, 'client disconnect')
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

  stats(): SessionStats | undefined {
    return this.#session?.stats()
  }

  async #doConnect(): Promise<void> {
    this.#patch({ status: 'connecting', lastError: null })
    try {
      const table = await buildEventTable(this.#opts.contract)
      const conn = await this.#opts.connect()

      // Chrome implements neither `requireUnreliable` nor `reliability`, so `undefined`
      // must pass or every session on the dominant browser would be refused. Only an
      // explicit reliable-only is a lie about the datagram lane.
      if (conn.reliability() === 'reliable-only') {
        throw new TransportError(
          'WT_RELIABILITY_REFUSED',
          'the session negotiated reliable-only transport',
          'The datagram lane would silently become reliable and ordered. This library refuses rather than lie about your data.',
        )
      }

      const session = new Session(conn, {
        table,
        origin: this.#opts.origin ?? 0x80000001,
        ...(this.#opts.validateInbound === undefined
          ? {}
          : { validateInbound: this.#opts.validateInbound }),
        ...(this.#opts.scheduleFlush === undefined
          ? {}
          : { scheduleFlush: this.#opts.scheduleFlush }),
        ...(this.#opts.now === undefined ? {} : { now: this.#opts.now }),
      })
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
