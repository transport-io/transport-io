/**
 * Handshake. PROTOCOL.md §4 — frame 0 of the emit stream.
 *
 * Being frame 0 of a stream that already exists is what removes the early-traffic race:
 * in-order delivery within a stream means nothing can arrive before it. There is no
 * separate handshake stream and no rule guarding one.
 */

import type { EventTable, Lane } from './contract.ts'
import { TransportError } from './errors.ts'
import { PROTOCOL_VERSION } from './protocol.ts'

export type WireEvent = readonly [name: string, id: number, lane: Lane]

export interface HandshakePayload {
  readonly v: number
  readonly feat: readonly string[]
  readonly events: readonly WireEvent[]
}

/** Reserved and unimplemented in this version. PROTOCOL.md §4.2. */
export const RESERVED_FEATURES: readonly string[] = [
  'emit-per-room',
  'codec-msgpack',
  'session-resume',
]

export function buildHandshake(
  table: EventTable,
  feat: readonly string[] = [],
): HandshakePayload {
  return { v: PROTOCOL_VERSION, feat, events: table.wire() }
}

export interface Negotiated {
  readonly feat: readonly string[]
  /** Events the peer knows that we do not. Sending one yields WT_UNKNOWN_EVENT, not a fault. */
  readonly peerOnly: readonly string[]
  /** Events we know that the peer does not. */
  readonly localOnly: readonly string[]
}

function isWireEvent(v: unknown): v is WireEvent {
  return (
    Array.isArray(v) &&
    v.length === 3 &&
    typeof v[0] === 'string' &&
    typeof v[1] === 'number' &&
    (v[2] === 'stream' || v[2] === 'datagram')
  )
}

export function parseHandshake(value: unknown): HandshakePayload {
  const bad = (why: string): never => {
    throw new TransportError(
      'WT_PROTOCOL_ERROR',
      `malformed handshake: ${why}`,
      'Check the sender against PROTOCOL.md §4.1.',
    )
  }
  if (typeof value !== 'object' || value === null) return bad('not an object')
  const { v, feat, events } = value as { v?: unknown; feat?: unknown; events?: unknown }
  if (typeof v !== 'number') return bad('`v` is not a number')
  if (!Array.isArray(feat) || feat.some((f) => typeof f !== 'string')) {
    return bad('`feat` is not an array of strings')
  }
  if (!Array.isArray(events) || !events.every(isWireEvent)) {
    return bad('`events` is not an array of [name, id, lane] triples')
  }
  return { v, feat: feat as string[], events: events as WireEvent[] }
}

/**
 * PROTOCOL.md §4.3 and §4.4. The event table is validated first and conflicts are fatal;
 * `feat` is negotiated second and is never fatal.
 *
 * Comparison is per event. A whole-contract equality check would refuse a session over an
 * added event, which turns every additive change into a fleet-wide cutover.
 */
export function negotiate(local: HandshakePayload, peer: HandshakePayload): Negotiated {
  if (peer.v !== local.v) {
    throw new TransportError(
      'WT_PROTOCOL_VERSION_MISMATCH',
      `peer speaks protocol v${peer.v} and this is v${local.v}`,
      'Protocol v0 is unstable and requires an exact match. Deploy both sides together.',
    )
  }

  const localByName = new Map(local.events.map((e) => [e[0], e]))
  const localById = new Map(local.events.map((e) => [e[1], e]))
  const peerByName = new Map(peer.events.map((e) => [e[0], e]))

  for (const [name, id, lane] of peer.events) {
    const mine = localByName.get(name)
    if (mine !== undefined) {
      if (mine[2] !== lane) {
        throw new TransportError(
          'WT_CONTRACT_MISMATCH',
          `event '${name}' is '${mine[2]}' here and '${lane}' at the peer`,
          'The two sides disagree about a delivery guarantee. Deploy the same contract on both.',
        )
      }
      if (mine[1] !== id) {
        throw new TransportError(
          'WT_CONTRACT_MISMATCH',
          `event '${name}' is id ${mine[1]} here and ${id} at the peer`,
          'One side has an explicit `id` override the other lacks. Align the contract.',
        )
      }
      continue
    }
    const collides = localById.get(id)
    if (collides !== undefined) {
      throw new TransportError(
        'WT_CONTRACT_MISMATCH',
        `peer event '${name}' has id ${id}, which is '${collides[0]}' here`,
        'Two different events share an id across the two sides. Align the contract.',
      )
    }
  }

  return {
    feat: local.feat.filter((f) => peer.feat.includes(f)),
    peerOnly: peer.events.filter((e) => !localByName.has(e[0])).map((e) => e[0]),
    localOnly: local.events.filter((e) => !peerByName.has(e[0])).map((e) => e[0]),
  }
}
