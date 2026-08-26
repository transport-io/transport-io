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
  readonly #nodeId: string
  readonly #table: EventTable
  readonly #rooms = new Map<string, Map<PeerId, Member>>()
  readonly #peerRooms = new Map<PeerId, Set<string>>()
  readonly #seqs = new Map<number, number>()

  constructor(adapter: Adapter, nodeId: string, table: EventTable) {
    this.#adapter = adapter
    this.#nodeId = nodeId
    this.#table = table
    // A node receiving its own publish back is normal, so core dedupes by origin node
    // rather than relying on the adapter to suppress it.
    this.#adapter.onRemote((e) => {
      if (e.nodeId === this.#nodeId) return
      this.#deliverLocal(e.room, e.frame, e.lane, e.except ?? [])
    })
  }

  async join(room: string, id: PeerId, session: Session): Promise<void> {
    let members = this.#rooms.get(room)
    if (members === undefined) {
      members = new Map()
      this.#rooms.set(room, members)
    }
    members.set(id, { id, session })
    let rooms = this.#peerRooms.get(id)
    if (rooms === undefined) {
      rooms = new Set()
      this.#peerRooms.set(id, rooms)
    }
    rooms.add(room)
    await this.#adapter.join(room, id)
    this.#notify(session, FrameType.JOIN, room)
  }

  async leave(room: string, id: PeerId): Promise<void> {
    const members = this.#rooms.get(room)
    const member = members?.get(id)
    members?.delete(id)
    if (members !== undefined && members.size === 0) this.#rooms.delete(room)
    this.#peerRooms.get(id)?.delete(room)
    await this.#adapter.leave(room, id)
    if (member !== undefined) this.#notify(member.session, FrameType.LEAVE, room)
  }

  async removePeer(id: PeerId): Promise<void> {
    for (const room of [...(this.#peerRooms.get(id) ?? [])]) {
      const members = this.#rooms.get(room)
      members?.delete(id)
      if (members !== undefined && members.size === 0) this.#rooms.delete(room)
      await this.#adapter.leave(room, id)
    }
    this.#peerRooms.delete(id)
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
      entry.lane === 'datagram'
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
      if (lane === 'datagram') m.session.sendDatagramBytes(bytes)
      else m.session.sendEncodedFrame(bytes)
    }
  }
}
