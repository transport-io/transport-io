/**
 * Type-level tests. A wrong event name or a wrong payload shape must fail to compile, and
 * the error must be readable — not a wall of conditional type.
 *
 * Uses expect-type rather than tsd: tsd consumes the TypeScript compiler API, which does
 * not exist between 7.0 and 7.1. See D54.
 */
import { expectTypeOf } from 'expect-type'
import type { Client } from './client.ts'
import { type CallableOf, defineContract, type MapOf, type$ } from './contract.ts'
import type { ServerPeer } from './server.ts'

const contract = defineContract({
  chat: { lane: 'stream', payload: type$<{ room: string; body: string }>() },
  cursor: { lane: 'datagram', payload: type$<{ x: number; y: number }>() },
  save: {
    lane: 'stream',
    payload: type$<{ docId: string }>(),
    returns: type$<{ revision: number }>(),
  },
})

// The two-line pattern. The interface is what keeps hover readable (D57).
export interface AppMap extends MapOf<typeof contract> {}

declare const client: Client<AppMap>
declare const peer: ServerPeer<AppMap>

// --- payloads are inferred in both directions, with no second annotation ---
expectTypeOf<AppMap['chat']['payload']>().toEqualTypeOf<{ room: string; body: string }>()
expectTypeOf<AppMap['cursor']['payload']>().toEqualTypeOf<{ x: number; y: number }>()

client.emit('chat', { room: 'lobby', body: 'hi' })
client.emit('cursor', { x: 1, y: 2 })
client.on('chat', (p) => {
  expectTypeOf(p).toEqualTypeOf<{ room: string; body: string }>()
})
peer.on('cursor', (p) => {
  expectTypeOf(p).toEqualTypeOf<{ x: number; y: number }>()
})

// --- only events declaring `returns` are callable ---
expectTypeOf<CallableOf<AppMap>>().toEqualTypeOf<'save'>()

// --- and the wrong shapes do not compile ---
// @ts-expect-error unknown event name
client.emit('chatt', { room: 'lobby', body: 'hi' })
// @ts-expect-error missing a required field
client.emit('chat', { room: 'lobby' })
// @ts-expect-error wrong field type
client.emit('chat', { room: 'lobby', body: 42 })
// @ts-expect-error a datagram payload sent under a stream event name
client.emit('chat', { x: 1, y: 2 })
// @ts-expect-error handler parameter cannot be widened to a mismatched shape
client.on('cursor', (p: { room: string }) => void p)

// D1, at the type level. `returns` on a datagram event must not compile: excess property
// checking against a union admits any property present on any member, so this was accepted
// and `CallableOf` then made the event callable.
const _badLane = defineContract({
  // @ts-expect-error a datagram event has no response path, so `returns` is not a thing
  cursor: { lane: 'datagram', payload: type$<{ x: number }>(), returns: type$<{ ok: true }>() },
})
void _badLane

// And the consequence: a datagram event is not in the callable set.
expectTypeOf<CallableOf<AppMap>>().toEqualTypeOf<'save'>()
