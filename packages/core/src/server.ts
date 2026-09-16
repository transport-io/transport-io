/** Server surface. Transport-agnostic: it accepts a Connection from the seam. */
import { type Adapter, MemoryAdapter, type PeerId } from './adapter.ts'
import {
  type AnyMap,
  buildEventTable,
  type CallableOf,
  type Contract,
  type EventTable,
  type FallbackReady,
  type Registered,
  type StreamableOf,
} from './contract.ts'
import { Hub } from './hub.ts'
import { OriginAllocator } from './origin.ts'
import { CloseCode } from './protocol.ts'
import { Session, type SessionStats } from './session.ts'
import type { CloseInfo, Connection, Transport } from './transport/types.ts'

export interface ServerPeer<M extends AnyMap = Registered, D = undefined> {
  readonly id: PeerId
  readonly origin: number
  /** What carries this peer's session. The reliable lane only, on anything but `webtransport`. */
  readonly transport: Transport
  /**
   * What the listener's `authorize` returned for this peer, `undefined` without one.
   * Assignable, so a server with no `authorize` can keep per-peer state here too.
   */
  data: D
  /**
   * Settles once the peer has left every room and released everything it held, so a
   * `memberCount` read after it reflects the departure. `onDisconnecting` runs before that.
   */
  readonly closed: Promise<CloseInfo>
  readonly rooms: readonly string[]
  join(room: string): Promise<void>
  leave(room: string): Promise<void>
  on<K extends keyof M & string>(
    event: K,
    handler: (payload: M[K]['payload']) => void,
  ): () => void
  emit<K extends keyof M & string>(event: K, payload: M[K]['payload']): void
  stats(): SessionStats
  close(code?: number, reason?: string): void
}

export interface CallContext<M extends AnyMap = Registered, D = undefined> {
  /** Fires when the initiator resets the stream. Immediate, and free on this transport. */
  readonly signal: AbortSignal
  /**
   * The peer that made this call.
   *
   * A responder is registered once and answers every peer, so this is the only thing that
   * says who is asking. `peer.id` is a value this server assigned itself and identifies
   * nobody: authenticate the payload, then use `peer.join` to act on the result.
   */
  readonly peer: ServerPeer<M, D>
}

/**
 * Anything that yields connections: a transport listener, or a test double. `D` is what a
 * listener's `authorize` attaches to each connection as `data`; a source without one yields
 * connections with no `data`, and the server's `D` must agree with the listener's.
 */
export interface ConnectionSource<D = undefined> {
  sessions(): AsyncIterable<Connection & { readonly data?: D }>
}

export interface ListenOptions {
  /**
   * Called for each accept that rejects. Without it the failure is still counted in
   * `acceptErrors`, so it is never silent, only quiet.
   */
  readonly onAcceptError?: (error: unknown) => void
}

export interface ServerOptions {
  readonly contract: Contract
  readonly adapter?: Adapter
  readonly nodeId?: string
  readonly hostOrdinal?: number
  readonly validateInbound?: boolean
}

export interface RoomTarget<M extends AnyMap = Registered> {
  emit<K extends keyof M & string>(event: K, payload: M[K]['payload']): Promise<void>
  except(...peers: PeerId[]): RoomTarget<M>
}

export class Server<M extends AnyMap = Registered, D = undefined> {
  readonly #opts: ServerOptions
  readonly #nodeId: string
  readonly #origins: OriginAllocator
  readonly #peers = new Map<PeerId, { peer: ServerPeer<M, D>; session: Session }>()
  #acceptErrors = 0
  readonly #onPeer: ((peer: ServerPeer<M, D>) => void)[] = []
  readonly #onDisconnecting: ((peer: ServerPeer<M, D>, info: CloseInfo) => void)[] = []
  #table: EventTable | undefined
  #hub: Hub | undefined
  #adapter: Adapter | undefined
  #nextPeer = 0
  #serverOrigin = 0
  readonly #callHandlers = new Map<string, (p: unknown, c: CallContext) => Promise<unknown>>()

  constructor(opts: ServerOptions) {
    this.#opts = opts
    this.#nodeId = opts.nodeId ?? `node-${Math.trunc(performance.now())}`
    this.#origins = new OriginAllocator(opts.hostOrdinal ?? 0)
  }

  /** Builds the event table once. Async because event ids are a SHA-256 of the name. */
  /**
   * Prepare the server, and optionally take ownership of the accept loop.
   *
   * Without a source this is what it always was, and `accept()` is yours to drive. With
   * one, `listen()` runs `for await (const conn of source.sessions()) accept(conn)` for
   * you. That loop existed in ten places in this repository alone, identical every time
   * and swallowing the rejection every time.
   *
   * A rejected accept is counted rather than discarded. A failed handshake must not take
   * the server down, so it cannot throw; it must not be undiscoverable either, so it
   * cannot vanish. `acceptErrors` is the count, and `onAcceptError` is for an application
   * that wants to do something about it.
   */
  async listen(source?: ConnectionSource<D>, opts?: ListenOptions): Promise<void> {
    this.#table = await buildEventTable(this.#opts.contract)
    this.#adapter = this.#opts.adapter ?? new MemoryAdapter(this.#nodeId)
    this.#hub = new Hub(this.#adapter, this.#table)
    // The server broadcasts on the unreliable lane too, so it needs its own origin.
    // Origin 0 is reserved, so it cannot simply be left unset.
    this.#serverOrigin = this.#origins.allocate(Date.now())

    if (source === undefined) return
    void this.#acceptFrom(source, opts)
  }

  /**
   * Accept sessions from a transport that carries the reliable lane only.
   *
   * The type is the gate: `FallbackReady<M>` is `unknown` when every unreliable event in the
   * contract declares a fallback, and otherwise a required property that names the event
   * which has not, so this line fails to compile rather than a session failing at runtime.
   * The session refuses at accept as well, for callers with no compiler (D121).
   */
  withFallback(source: ConnectionSource<D> & FallbackReady<M>, opts?: ListenOptions): void {
    this.#requireTable()
    void this.#acceptFrom(source, opts)
  }

  #acceptFrom(source: ConnectionSource<D>, opts?: ListenOptions): Promise<void> {
    const loop = (async () => {
      for await (const conn of source.sessions()) {
        // Per connection, so one refused handshake does not end the loop for everyone
        // else. Awaiting here would serialise accepts behind the slowest handshake.
        void this.accept(conn).catch((e: unknown) => {
          this.#acceptErrors++
          opts?.onAcceptError?.(e)
        })
      }
    })()
    // The loop ends when the source ends, which is a transport concern rather than an
    // error. A source that throws surfaces through `acceptErrors` the same way.
    loop.catch((e: unknown) => {
      this.#acceptErrors++
      opts?.onAcceptError?.(e)
    })
    return loop
  }

  /**
   * Accepts that failed since `listen()`. Zero on a healthy server, and the only signal
   * that connections are being refused when nobody installed `onAcceptError`.
   */
  get acceptErrors(): number {
    return this.#acceptErrors
  }

  /** Register a responder for a callable event. */
  handle<K extends CallableOf<M> & string>(
    event: K,
    handler: (payload: M[K]['payload'], ctx: CallContext<M, D>) => Promise<M[K]['returns']>,
  ): () => void
  /**
   * Register a responder for a streaming event. The handler is an async generator: each
   * `yield` is one frame, and it does not resume until that frame has been accepted, so a
   * slow consumer slows the generator instead of filling a queue.
   */
  handle<K extends StreamableOf<M> & string>(
    event: K,
    handler: (
      payload: M[K]['payload'],
      ctx: CallContext<M, D>,
    ) => AsyncIterable<M[K]['yields']>,
  ): () => void
  handle(
    event: string,
    handler: (payload: never, ctx: CallContext<M, D>) => never,
  ): () => void {
    this.#callHandlers.set(event, handler as never)
    for (const { session } of this.#peers.values()) {
      session.handle(event, handler as never)
    }
    return () => {
      this.#callHandlers.delete(event)
      // Sweeping current peers rather than the ones present at registration: a session
      // accepted in between picked the handler up from `#callHandlers`, so it has to be
      // revoked too. Deleting from the map alone left every already-connected peer still
      // being answered - revoking a privileged responder did nothing for anyone connected.
      for (const { session } of this.#peers.values()) session.unhandle(event)
    }
  }

  onSession(cb: (peer: ServerPeer<M, D>) => void): () => void {
    this.#onPeer.push(cb)
    return () => {
      const i = this.#onPeer.indexOf(cb)
      if (i >= 0) this.#onPeer.splice(i, 1)
    }
  }

  /**
   * Runs when a peer's connection has closed and before it leaves its rooms, so
   * `peer.rooms` still says where it was. `peer.closed` settles after the rooms are left.
   */
  onDisconnecting(cb: (peer: ServerPeer<M, D>, info: CloseInfo) => void): () => void {
    this.#onDisconnecting.push(cb)
    return () => {
      const i = this.#onDisconnecting.indexOf(cb)
      if (i >= 0) this.#onDisconnecting.splice(i, 1)
    }
  }

  memberCount(room: string): number {
    return this.#requireHub().memberCount(room)
  }

  async accept(conn: Connection & { readonly data?: D }): Promise<ServerPeer<M, D>> {
    const table = this.#requireTable()
    const hub = this.#requireHub()
    const id: PeerId = `${this.#nodeId}:${this.#nextPeer++}`
    const origin = this.#origins.allocate(Date.now())
    let settleClosed!: (info: CloseInfo) => void
    const closed = new Promise<CloseInfo>((resolve) => {
      settleClosed = resolve
    })

    const session = new Session(conn, {
      table,
      origin,
      ...(this.#opts.validateInbound === undefined
        ? {}
        : { validateInbound: this.#opts.validateInbound }),
    })

    const peer: ServerPeer<M, D> = {
      id,
      origin,
      transport: conn.kind(),
      data: (conn as { data?: D }).data as D,
      closed,
      get rooms() {
        return hub.rooms(id)
      },
      join: (room) => hub.join(room, id, session),
      leave: (room) => hub.leave(room, id),
      on: (event, handler) => session.on(event, (payload) => handler(payload as never)),
      emit: (event, payload) => session.emit(event, payload),
      stats: () => session.stats(),
      close: (code = CloseCode.WT_NO_ERROR, reason = '') => session.close(code, reason),
    }

    // Before any responder is registered, so no handler can ever observe an absent peer.
    session.attachPeer(peer)
    for (const [event, handler] of this.#callHandlers) session.handle(event, handler as never)
    this.#peers.set(id, { peer, session })
    void conn.closed
      .then(async (info) => {
        // Before the rooms go, so presence code can still read where the peer was.
        for (const cb of this.#onDisconnecting) cb(peer, info)
        this.#peers.delete(id)
        this.#origins.free(origin, Date.now())
        session.dispose()
        await hub.removePeer(id)
        settleClosed(info)
      })
      // Teardown is the last thing that runs for this peer; there is no caller left to
      // hand a rejection to. Without this it was an unhandled rejection, which ends the
      // process under Node's default - the opposite of what ADR/0005 and D40 promise.
      .catch(() => undefined)

    await session.start()
    for (const cb of this.#onPeer) cb(peer)
    return peer
  }

  to(room: string): RoomTarget<M> {
    const hub = this.#requireHub()
    const make = (except: PeerId[]): RoomTarget<M> => ({
      emit: (event, payload) =>
        hub.broadcast(room, event, payload, { origin: this.#serverOrigin, except }),
      except: (...peers) => make([...except, ...peers]),
    })
    return make([])
  }

  #requireTable(): EventTable {
    if (this.#table === undefined) throw new Error('call listen() before accept()')
    return this.#table
  }
  #requireHub(): Hub {
    if (this.#hub === undefined) throw new Error('call listen() before use')
    return this.#hub
  }
}

export function createServer<M extends AnyMap = Registered, D = undefined>(
  opts: ServerOptions,
): Server<M, D> {
  return new Server<M, D>(opts)
}
