/**
 * A deliberately hostile Adapter, for conformance testing.
 *
 * `MemoryAdapter` is a misleading sole implementor: it is effectively synchronous, never
 * fails, passes live object references and always knows a room's full membership. None of
 * that holds for a real bus, so core could satisfy it perfectly and still be unshippable
 * on Redis.
 *
 * This one behaves like a bus. It serialises every frame to bytes and back, adds
 * artificial latency, delivers the publisher its own messages, reorders deliveries, and
 * fails on command. If core passes against this, the boundary should survive a real
 * broker. No network and no Redis: hostility is cheaper than infrastructure.
 */
import {
  type Adapter,
  type BroadcastOptions,
  type Frame,
  type MemoryBus,
  memoryBus,
  type PeerId,
  type RemoteEnvelope,
} from '../adapter.ts'

export interface HostileOptions {
  /** Delivery is deferred by this many milliseconds. Real buses are not synchronous. */
  readonly latencyMs?: number
  /** Deliver envelopes in reverse order within each batch. */
  readonly reorder?: boolean
  /** Deliver every envelope twice. A real bus is at-least-once. */
  readonly duplicate?: boolean
}

export class HostileAdapter implements Adapter {
  readonly #rooms = new Map<string, Set<PeerId>>()
  readonly #bus: MemoryBus
  readonly #opts: HostileOptions
  readonly nodeId: string

  /** Set to make the next call of that method reject. Cleared after it fires. */
  failNextJoin = false
  failNextLeave = false
  failNextBroadcast = false

  #pending: RemoteEnvelope[] = []
  #timer: ReturnType<typeof setTimeout> | undefined

  /**
   * `bus` lets several of these model several nodes on one broker. Without it each
   * instance is its own island, which is why the cross-node path went untested against the
   * adapter written specifically to stress the adapter boundary.
   */
  constructor(nodeId: string, opts: HostileOptions = {}, bus: MemoryBus = memoryBus()) {
    this.nodeId = nodeId
    this.#opts = opts
    this.#bus = bus
  }

  async join(room: string, peer: PeerId): Promise<void> {
    await this.#tick()
    if (this.failNextJoin) {
      this.failNextJoin = false
      throw new Error('hostile adapter: join rejected')
    }
    let set = this.#rooms.get(room)
    if (set === undefined) {
      set = new Set()
      this.#rooms.set(room, set)
    }
    set.add(peer)
  }

  async leave(room: string, peer: PeerId): Promise<void> {
    await this.#tick()
    if (this.failNextLeave) {
      this.failNextLeave = false
      throw new Error('hostile adapter: leave rejected')
    }
    this.#rooms.get(room)?.delete(peer)
  }

  async broadcast(room: string, frame: Frame, opts: BroadcastOptions): Promise<void> {
    await this.#tick()
    if (this.failNextBroadcast) {
      this.failNextBroadcast = false
      throw new Error('hostile adapter: broadcast rejected')
    }

    // Round-trip through bytes. A live object reference would survive a structural change
    // that a real bus would not, so this is where that assumption dies.
    const wire = JSON.stringify({
      room,
      frame: [...frame],
      lane: opts.lane,
      nodeId: this.nodeId,
      except: opts.except ?? [],
    })
    const parsed = JSON.parse(wire) as {
      room: string
      frame: number[]
      lane: 'stream' | 'datagram'
      nodeId: string
      except: string[]
    }
    const envelope: RemoteEnvelope = {
      room: parsed.room,
      frame: Uint8Array.from(parsed.frame),
      lane: parsed.lane,
      nodeId: parsed.nodeId,
      except: parsed.except,
    }

    // The publisher gets its own message back, because a real bus does not know who sent
    // what and core must dedupe rather than rely on suppression.
    this.#pending.push(envelope)
    if (this.#opts.duplicate === true) this.#pending.push(envelope)
    this.#schedule()
  }

  onRemote(cb: (e: RemoteEnvelope) => void): void {
    this.#bus.listeners.push(cb)
  }

  /** Deliberately NOT exposed to core: no node may assume it knows full membership. */
  membershipForAssertionsOnly(room: string): ReadonlySet<PeerId> {
    return this.#rooms.get(room) ?? new Set()
  }

  async settle(): Promise<void> {
    for (let i = 0; i < 8; i++)
      await new Promise((r) => setTimeout(r, (this.#opts.latencyMs ?? 1) + 1))
  }

  #schedule(): void {
    if (this.#timer !== undefined) return
    this.#timer = setTimeout(() => {
      this.#timer = undefined
      const batch = this.#pending
      this.#pending = []
      if (this.#opts.reorder === true) batch.reverse()
      for (const e of batch) for (const l of this.#bus.listeners) l(e)
    }, this.#opts.latencyMs ?? 1)
  }

  async #tick(): Promise<void> {
    await new Promise((r) => setTimeout(r, this.#opts.latencyMs ?? 1))
  }
}
