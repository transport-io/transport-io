/**
 * The fan-out boundary. PROTOCOL.md is silent on this by design: it is our contract with
 * a message bus, not with a peer.
 *
 * Rules core obeys (D40): every method is async even in memory, frames cross as bytes and
 * never as live objects, `PeerId` is a stable cross-process string, no node assumes it
 * knows a room's full membership, a frame for a room with no local members is dropped
 * silently rather than erroring, and any method may reject — core degrades rather than
 * crashing.
 */
export type PeerId = string
export type Frame = Uint8Array
export type Lane = 'stream' | 'datagram'

/** The envelope carries the origin node. The frame the peer receives is not these bytes. */
export interface RemoteEnvelope {
  readonly room: string
  readonly frame: Frame
  readonly lane: Lane
  readonly nodeId: string
  readonly except?: readonly PeerId[]
}

export interface BroadcastOptions {
  readonly lane: Lane
  readonly except?: readonly PeerId[]
}

export interface Adapter {
  join(room: string, peer: PeerId): Promise<void>
  leave(room: string, peer: PeerId): Promise<void>
  broadcast(room: string, frame: Frame, opts: BroadcastOptions): Promise<void>
  onRemote(cb: (envelope: RemoteEnvelope) => void): void
}

/**
 * Write-only half of the boundary, for a caller that publishes without hosting sessions.
 * Internal in this version (D22): the interface is a design constraint, and a
 * cross-process implementation arrives with the Redis adapter.
 */
export interface Publisher {
  broadcast(room: string, frame: Frame, opts: BroadcastOptions): Promise<void>
}

/** Ships in core and is the default, so installing this library needs no infrastructure. */
export class MemoryAdapter implements Adapter {
  readonly #rooms = new Map<string, Set<PeerId>>()
  readonly #listeners: ((e: RemoteEnvelope) => void)[] = []
  readonly nodeId: string

  constructor(nodeId: string) {
    this.nodeId = nodeId
  }

  async join(room: string, peer: PeerId): Promise<void> {
    let set = this.#rooms.get(room)
    if (set === undefined) {
      set = new Set()
      this.#rooms.set(room, set)
    }
    set.add(peer)
  }

  async leave(room: string, peer: PeerId): Promise<void> {
    const set = this.#rooms.get(room)
    if (set === undefined) return
    set.delete(peer)
    if (set.size === 0) this.#rooms.delete(room)
  }

  async broadcast(room: string, frame: Frame, opts: BroadcastOptions): Promise<void> {
    // A single process still delivers its own publish back, because that is what a real
    // bus does and core must dedupe rather than rely on the adapter suppressing it.
    const envelope: RemoteEnvelope = {
      room,
      frame,
      lane: opts.lane,
      nodeId: this.nodeId,
      ...(opts.except === undefined ? {} : { except: opts.except }),
    }
    for (const l of this.#listeners) l(envelope)
  }

  onRemote(cb: (e: RemoteEnvelope) => void): void {
    this.#listeners.push(cb)
  }
}
