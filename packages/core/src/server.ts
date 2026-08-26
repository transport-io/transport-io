/** Server surface. Transport-agnostic: it accepts a Connection from the seam. */
import { type Adapter, MemoryAdapter, type PeerId } from './adapter.ts'
import {
  type AnyMap,
  buildEventTable,
  type CallableOf,
  type Contract,
  type EventTable,
} from './contract.ts'
import { Hub } from './hub.ts'
import { OriginAllocator } from './origin.ts'
import { CloseCode } from './protocol.ts'
import { Session, type SessionStats } from './session.ts'
import type { Connection } from './transport/types.ts'

export interface ServerPeer<M extends AnyMap = AnyMap> {
  readonly id: PeerId
  readonly origin: number
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

export interface CallContext {
  /** Fires when the initiator resets the stream. Immediate, and free on this transport. */
  readonly signal: AbortSignal
}

export interface ServerOptions {
  readonly contract: Contract
  readonly adapter?: Adapter
  readonly nodeId?: string
  readonly hostOrdinal?: number
  readonly validateInbound?: boolean
}

export interface RoomTarget<M extends AnyMap = AnyMap> {
  emit<K extends keyof M & string>(event: K, payload: M[K]['payload']): Promise<void>
  except(...peers: PeerId[]): RoomTarget<M>
}

export class Server<M extends AnyMap = AnyMap> {
  readonly #opts: ServerOptions
  readonly #nodeId: string
  readonly #origins: OriginAllocator
  readonly #peers = new Map<PeerId, { peer: ServerPeer<M>; session: Session }>()
  readonly #onPeer: ((peer: ServerPeer<M>) => void)[] = []
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
  async listen(): Promise<void> {
    this.#table = await buildEventTable(this.#opts.contract)
    this.#adapter = this.#opts.adapter ?? new MemoryAdapter(this.#nodeId)
    this.#hub = new Hub(this.#adapter, this.#nodeId, this.#table)
    // The server broadcasts on the datagram lane too, so it needs its own origin.
    // Origin 0 is reserved, so it cannot simply be left unset.
    this.#serverOrigin = this.#origins.allocate(Date.now())
  }

  /** Register a responder for a callable event. */
  handle<K extends CallableOf<M> & string>(
    event: K,
    handler: (payload: M[K]['payload'], ctx: CallContext) => Promise<M[K]['returns']>,
  ): () => void {
    this.#callHandlers.set(event, handler as never)
    for (const { session } of this.#peers.values()) {
      session.handle(event, handler as never)
    }
    return () => {
      this.#callHandlers.delete(event)
    }
  }

  onSession(cb: (peer: ServerPeer<M>) => void): () => void {
    this.#onPeer.push(cb)
    return () => {
      const i = this.#onPeer.indexOf(cb)
      if (i >= 0) this.#onPeer.splice(i, 1)
    }
  }

  memberCount(room: string): number {
    return this.#requireHub().memberCount(room)
  }

  async accept(conn: Connection): Promise<ServerPeer<M>> {
    const table = this.#requireTable()
    const hub = this.#requireHub()
    const id: PeerId = `${this.#nodeId}:${this.#nextPeer++}`
    const origin = this.#origins.allocate(Date.now())

    const session = new Session(conn, {
      table,
      origin,
      ...(this.#opts.validateInbound === undefined
        ? {}
        : { validateInbound: this.#opts.validateInbound }),
    })

    const peer: ServerPeer<M> = {
      id,
      origin,
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

    for (const [event, handler] of this.#callHandlers) session.handle(event, handler as never)
    this.#peers.set(id, { peer, session })
    void conn.closed
      .then(async () => {
        this.#peers.delete(id)
        this.#origins.free(origin, Date.now())
        session.dispose()
        await hub.removePeer(id)
      })
      // Teardown is the last thing that runs for this peer; there is no caller left to
      // hand a rejection to. Without this it was an unhandled rejection, which ends the
      // process under Node's default — the opposite of what ADR/0005 and D40 promise.
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

export function createServer<M extends AnyMap = AnyMap>(opts: ServerOptions): Server<M> {
  return new Server<M>(opts)
}
