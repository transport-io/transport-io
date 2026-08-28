/**
 * Module augmentation: register the map once, drop the type argument everywhere.
 *
 * The interesting assertions are the two failure shapes. A registration that silently did
 * nothing would leave every call site typed as `AnyMap`, which accepts any event name and
 * any payload, and this file would pass while the feature did not work. So the tests check
 * that wrong event names are refused *after* registering, not merely that correct ones are
 * accepted.
 *
 * `Register` holds the map rather than the contract, and D100 records the measurement: a
 * conditional over the contract expands in hover to 377 characters where the interface
 * prints as `Client<AppMap>` at 107.
 */
import { expectTypeOf } from 'expect-type'
import type { Client } from './client.ts'
import { defineContract, type MapOf, type Register, reliable, rpc } from './contract.ts'
import type { createServer } from './server.ts'

const contract = defineContract({
  chat: reliable<{ body: string }>(),
  save: rpc<{ text: string }, { n: number }>(),
})
interface AppMap extends MapOf<typeof contract> {}

declare module './contract.ts' {
  interface Register {
    map: AppMap
  }
}

// --- no type argument anywhere ---

declare const client: Client
declare const server: ReturnType<typeof createServer>

client.emit('chat', { body: 'hi' })
void client.call('save', { text: 'x' })

// The payload type comes from the registration, not from `AnyMap`.
client.on('chat', (p) => {
  expectTypeOf(p).toEqualTypeOf<{ body: string }>()
})
expectTypeOf(client.call('save', { text: 'x' })).resolves.toEqualTypeOf<{ n: number }>()

// --- and wrong usage is still refused, which is what proves registration took effect ---

// @ts-expect-error 'nope' is not in the registered contract
client.emit('nope', { body: 'hi' })

// @ts-expect-error the payload shape comes from the contract
client.emit('chat', { wrong: true })

// @ts-expect-error 'chat' declares no `returns`, so it is not callable
void client.call('chat', { body: 'hi' })

// --- the explicit type argument still works, for two contracts in one process ---

const other = defineContract({ ping: reliable<{ seq: number }>() })
interface OtherMap extends MapOf<typeof other> {}

declare const explicit: Client<OtherMap>
explicit.emit('ping', { seq: 1 })

// @ts-expect-error the explicit argument wins over the registration
explicit.emit('chat', { body: 'hi' })

// The registered client is unaffected by the second contract existing.
// @ts-expect-error 'ping' belongs to the other contract
client.emit('ping', { seq: 1 })

declare const explicitServer: ReturnType<typeof createServer<OtherMap>>
expectTypeOf(explicitServer).not.toEqualTypeOf(server)

// --- the augmentation point must remain an interface ---
//
// `lint:fix` once rewrote `export interface Register {}` to `export type Register = {}`,
// which compiles cleanly in the library and then fails every application's registration
// with "Duplicate identifier 'Register'". A type alias cannot be augmented. This assertion
// exists so the rewrite cannot happen silently again: it only holds if the declaration
// merged, and merging only works for an interface.
expectTypeOf<Register['map']>().toEqualTypeOf<AppMap>()
