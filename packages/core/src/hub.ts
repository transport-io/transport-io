/**
 * Rooms and fan-out. Server-side.
 *
 * A frame is encoded ONCE and the same bytes go to every local member and onto the bus.
 * That is what makes origin-scoped datagram sequencing correct: a per-recipient re-encode
 * would be needed if the sequence belonged to the receiving session, and the adapter
 * boundary forbids it anyway.
 *
 * Local peers are delivered directly rather than via a bus round-trip: lower latency and
 * no dependency on the adapter echoing. The documented consequence is that local peers
 * observe a message slightly before remote ones.
 */
import type { Adapter, Lane, PeerId } from './adapter.ts'
import { encodePayload } from './codec.ts'
import type { EventTable } from './contract.ts'
import { encodeDatagram } from './datagram.ts'
import { TransportError } from './errors.ts'
import { encodeFrame } from './framer.ts'
import { Codec, DATAGRAM_CONSERVATIVE_FLOOR, FrameType } from './protocol.ts'
import type { Session } from './session.ts'

interface Member {
  readonly id: PeerId
  readonly session: Session
}

export interface BroadcastArgs {
  readonly origin: number
  readonly except?: readonly PeerId[]
}

export class Hub {
  readonly #adapter: Adapter
  readonly #table: EventTable
  readonly #rooms = new Map<string, Map<PeerId, Member>>()
  readonly #peerRooms = new Map<PeerId, Set<string>>()
  readonly #seqs = new Map<number, number>()

  constructor(adapter: Adapter, table: EventTable) {
    this.#adapter = adapter
    this.#table = table
    // A node receiving its own publish back is normal, so core dedupes by origin node
    // rather than relying on the adapter to suppress it - and dedupes against the
    // *adapter's* id, which is the one stamped into the envelope. It used to compare
    // against the Server's separate `nodeId`, so any deployment where those differed
    // delivered every local broadcast twice, in silence.
    this.#adapter.onRemote((e) => {
      if (e.nodeId === this.#adapter.nodeId) return
      this.#deliverLocal(e.room, e.frame, e.lane, e.except ?? [])
    })
  }

  async join(room: string, id: PeerId, session: Session): Promise<void> {
    // `onSession(async peer => { await lookup(); await peer.join(room) })` is the pattern
    // the README teaches, so a client dropping during the lookup lands here routinely.
    // Such a join used to succeed and be retained for ever: the JOIN notify write died in
    // the emit path's swallowing catch, so nothing surfaced, and the teardown that would
    // have removed it had already run.
    if (session.disposed) {
      throw new TransportError(
        'WT_SESSION_CLOSED',
        `peer ${id} disconnected before it could join '${room}'`,
        'Check the peer is still connected after any await, or ignore this - it is routine.',
      )
    }
    let members = this.#rooms.get(room)
    if (members === undefined) {
      members = new Map()
      this.#rooms.set(room, members)
    }
    // The bus first, local state second. Mutating before the await left a rejected join
    // half-applied: the hub fanned broadcasts to a peer the bus had no record of, and the
    // client was never notified it had joined. For a room whose join is gated on
    // authorization, that is traffic reaching someone who was refused - permanently,
    // because nothing rolls it back and nothing retries.
    await this.#adapter.join(room, id)

    members.set(id, { id, session })
    let rooms = this.#peerRooms.get(id)
    if (rooms === undefined) {
      rooms = new Set()
      this.#peerRooms.set(id, rooms)
    }
    rooms.add(room)
    this.#notify(session, FrameType.JOIN, room)
  }

  async leave(room: string, id: PeerId): Promise<void> {
    const members = this.#rooms.get(room)
    const member = members?.get(id)
    members?.delete(id)
    if (members !== undefined && members.size === 0) this.#rooms.delete(room)
    this.#peerRooms.get(id)?.delete(room)
    // Local state and the peer are settled before the bus is told, so a bus that rejects
    // leaves this node consistent. The rejection still reaches the caller, who asked.
    if (member !== undefined) this.#notify(member.session, FrameType.LEAVE, room)
    await this.#adapter.leave(room, id)
  }

  /**
   * Teardown runs to completion whatever the bus does.
   *
   * `broadcast` already wrapped its adapter call; this did not, so a rejection on the
   * first room threw straight out of the loop - rooms 2..N kept their `Member` record,
   * each holding a live Session, and `#peerRooms.delete(id)` never ran. Nothing retries,
   * because `conn.closed` resolves exactly once. A later `to(room).emit()` then fanned
   * frames into a session that was already gone.
   *
   * The local half is what this node's correctness depends on, so it is unconditional.
   * The bus half is best-effort by nature: the peer's connection is already gone, and a
   * bus that cannot be told now will not be told by us failing here.
   */
  async removePeer(id: PeerId): Promise<void> {
    const rooms = [...(this.#peerRooms.get(id) ?? [])]
    this.#peerRooms.delete(id)
    for (const room of rooms) {
      const members = this.#rooms.get(room)
      members?.delete(id)
      if (members !== undefined && members.size === 0) this.#rooms.delete(room)
    }
    await Promise.allSettled(rooms.map((room) => this.#adapter.leave(room, id)))
  }

  rooms(id: PeerId): readonly string[] {
    return [...(this.#peerRooms.get(id) ?? [])]
  }

  memberCount(room: string): number {
    return this.#rooms.get(room)?.size ?? 0
  }

  async broadcast(
    room: string,
    event: string,
    payload: unknown,
    args: BroadcastArgs,
  ): Promise<void> {
    const entry = this.#table.byName(event)
    if (entry === undefined) {
      throw new TransportError(
        'WT_UNKNOWN_EVENT',
        `'${event}' is not in the contract`,
        'Add it to the contract, or check the spelling.',
      )
    }
    const body = encodePayload(payload)
    const except = args.except ?? []

    const bytes =
      entry.lane === 'unreliable'
        ? encodeDatagram(
            {
              eventId: entry.id,
              origin: args.origin,
              sequence: this.#nextSeq(entry.id),
              payload: body,
            },
            DATAGRAM_CONSERVATIVE_FLOOR,
          )
        : encodeFrame({
            type: FrameType.EMIT,
            codec: Codec.JSON,
            eventId: entry.id,
            payload: body,
          })

    this.#deliverLocal(room, bytes, entry.lane, except)
    try {
      await this.#adapter.broadcast(room, bytes, { lane: entry.lane, except })
    } catch {
      // Any adapter method may reject. Core degrades rather than crashing: local members
      // already have the message and every session stays up.
    }
  }

  #nextSeq(eventId: number): number {
    const n = ((this.#seqs.get(eventId) ?? 0) + 1) >>> 0 || 1
    this.#seqs.set(eventId, n)
    return n
  }

  #notify(
    session: Session,
    type: typeof FrameType.JOIN | typeof FrameType.LEAVE,
    room: string,
  ): void {
    session.sendFrame({ type, codec: Codec.JSON, eventId: 0, payload: encodePayload({ room }) })
  }

  #deliverLocal(room: string, bytes: Uint8Array, lane: Lane, except: readonly PeerId[]): void {
    const members = this.#rooms.get(room)
    if (members === undefined) return // no local members is not an error
    for (const m of members.values()) {
      if (except.includes(m.id)) continue
      if (lane === 'unreliable') m.session.sendDatagramBytes(bytes)
      else m.session.sendEncodedFrame(bytes)
    }
  }
}
