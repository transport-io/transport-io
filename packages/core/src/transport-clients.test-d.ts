/**
 * The construct-and-connect forms, and the one thing about them that is easy to get wrong.
 *
 * `devClient`, `browserClient` and `http3Client` all take the map as an explicit type
 * argument that is **not** inferred from `contract`. Inferring it is the obvious thing and
 * the wrong thing: it would hand back `Client<MapOf<typeof contract>>`, whose every method
 * hover is 377 characters of validator internals against 107 for a named interface (D100).
 *
 * The shorter call must therefore never be the worse one. Omitting the argument falls to
 * `Registered`, so it either works because the application registered its map, or fails with
 * the sentinel that names the fix. This file pins the second case, which is the one nobody
 * would notice regressing: an accidental inference site would turn that compile error into a
 * working client with an unreadable type, and every gate here would stay green.
 *
 * `http3Client` is identical by construction and cannot be imported here: it lives in a
 * `*.node.ts` module and this file is not one. `milestone.node.test.ts` covers it.
 *
 * Proves this normative statement, which names this file back:
 *
 *   client-map-never-inferred
 */
import { expectTypeOf } from 'expect-type'
import type { Client } from './client.ts'
import { defineContract, type MapOf, reliable, rpc } from './contract.ts'
import { browserClient } from './transport/browser.ts'
import { devClient } from './transport/dev.ts'

const contract = defineContract({
  chat: reliable<{ from: string; body: string }>(),
  save: rpc<{ text: string }, { revision: number }>(),
})
interface AppMap extends MapOf<typeof contract> {}

declare const url: string

// --- the explicit map, which is what every example writes ---

expectTypeOf(devClient<AppMap>({ contract })).resolves.toEqualTypeOf<Client<AppMap>>()
expectTypeOf(browserClient<AppMap>({ contract, url })).resolves.toEqualTypeOf<Client<AppMap>>()

const client = await devClient<AppMap>({ contract })

client.emit('chat', { from: 'a', body: 'b' })
expectTypeOf(client.call('save', { text: 'x' })).resolves.toEqualTypeOf<{ revision: number }>()
client.on('chat', (p) => {
  expectTypeOf(p).toEqualTypeOf<{ from: string; body: string }>()
})

// @ts-expect-error the payload shape comes from the contract, not from `AnyMap`
client.emit('chat', { wrong: true })

// @ts-expect-error 'nope' is not in the contract
client.emit('nope', {})

// --- and the trap, closed ---

// Passing the contract does not make the map inferable, so this is `Client<Registered>`.
const unbound = await devClient({ contract })

// @ts-expect-error nothing is registered in this program, so the sentinel refuses every event
unbound.emit('chat', { from: 'a', body: 'b' })

// The same for the browser form, because one of the three being wired differently is exactly
// how this would come back.
const unboundBrowser = await browserClient({ contract, url })
// @ts-expect-error nothing is registered in this program, so the sentinel refuses every event
unboundBrowser.emit('chat', { from: 'a', body: 'b' })
