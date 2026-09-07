/**
 * The contract gate at the type level (D121).
 *
 * A fallback transport carries the reliable lane only, so a contract may only be wired to
 * one when every unreliable event has said what it accepts there. The check is a type on
 * the line that adds the fallback, and the error names the event, so nobody finds out in
 * production. Each case below is the one the scratch compile established while the gate was
 * being designed; this file is what keeps them true.
 */
import { expectTypeOf } from 'expect-type'
import type { Client, FallbackClient, NativeLanes } from './client.ts'
import { withFallback } from './client.ts'
import {
  defineContract,
  type FallbackReady,
  type MapOf,
  reliable,
  rpc,
  type$,
  unreliable,
} from './contract.ts'
import type { ConnectionSource, Server } from './server.ts'
import type { Connection } from './transport/types.ts'

declare const connect: () => Promise<Connection>
declare const fallback: () => Promise<Connection>
declare const source: ConnectionSource

// --- an undeclared unreliable event refuses the fallback, and the error names it ---
const undeclared = defineContract({
  chat: reliable<{ body: string }>(),
  cursor: unreliable<{ x: number; y: number }>(),
})
interface UndeclaredMap extends MapOf<typeof undeclared> {}

// @ts-expect-error cursor is unreliable and declares no fallback
withFallback<UndeclaredMap>({ contract: undeclared, connect, fallback })
expectTypeOf<FallbackReady<UndeclaredMap>>().toEqualTypeOf<{
  readonly 'fallback refused': "event 'cursor' is unreliable and declares no fallback"
}>()

declare const undeclaredServer: Server<UndeclaredMap>
// @ts-expect-error the server gate is the same type
undeclaredServer.withFallback(source)

// --- declared through the helper, with a type argument ---
const declared = defineContract({
  chat: reliable<{ body: string }>(),
  cursor: unreliable<{ x: number; y: number }>({ fallback: 'newest' }),
  save: rpc<{ text: string }, { n: number }>(),
})
interface DeclaredMap extends MapOf<typeof declared> {}

expectTypeOf<FallbackReady<DeclaredMap>>().toEqualTypeOf<unknown>()
const client = withFallback<DeclaredMap>({ contract: declared, connect, fallback })
expectTypeOf(client).toEqualTypeOf<FallbackClient<DeclaredMap>>()
client.emit('cursor', { x: 1, y: 2 })
client.emit('chat', { body: 'hi' })

declare const declaredServer: Server<DeclaredMap>
declaredServer.withFallback(source)

// --- call() and stream() are not methods of a fallback client; they live on `native` ---
// @ts-expect-error call() is native only
client.call('save', { text: 'x' })
// @ts-expect-error stream() is native only
void client.stream
expectTypeOf(client.native).toEqualTypeOf<NativeLanes<DeclaredMap> | null>()
const lanes = client.native
if (lanes !== null) {
  expectTypeOf(lanes.call('save', { text: 'x' })).toEqualTypeOf<Promise<{ n: number }>>()
}
// A plain client keeps both, and is not assignable where a fallback client is expected in
// reverse either: the two are different shapes on purpose.
declare const plain: Client<DeclaredMap>
expectTypeOf(plain.call('save', { text: 'x' })).toEqualTypeOf<Promise<{ n: number }>>()

// --- one declared and one not: the error names only the one that is not ---
const point = type$<{ x: number; y: number }>()
const mixed = defineContract({
  cursor: unreliable(point, { fallback: 'newest' }),
  pos: unreliable(point),
})
interface MixedMap extends MapOf<typeof mixed> {}
expectTypeOf<FallbackReady<MixedMap>>().toEqualTypeOf<{
  readonly 'fallback refused': "event 'pos' is unreliable and declares no fallback"
}>()

// --- no unreliable events at all passes ---
const none = defineContract({ chat: reliable<{ body: string }>() })
interface NoneMap extends MapOf<typeof none> {}
withFallback<NoneMap>({ contract: none, connect, fallback })

// --- the map carries the lane and the declaration, which is what the gate reads ---
expectTypeOf<DeclaredMap['cursor']['lane']>().toEqualTypeOf<'unreliable'>()
expectTypeOf<DeclaredMap['cursor']['fallback']>().toEqualTypeOf<'newest'>()
expectTypeOf<DeclaredMap['chat']['lane']>().toEqualTypeOf<'reliable'>()
expectTypeOf<DeclaredMap['chat']['fallback']>().toEqualTypeOf<undefined>()

// --- the object-literal form carries it too, and a reliable event cannot ---
const literal = defineContract({
  cursor: { lane: 'unreliable', payload: type$<{ x: number }>(), fallback: 'newest' },
})
interface LiteralMap extends MapOf<typeof literal> {}
expectTypeOf<FallbackReady<LiteralMap>>().toEqualTypeOf<unknown>()
defineContract({
  // @ts-expect-error a reliable event has nothing to fall back from
  chat: { lane: 'reliable', payload: type$<{ body: string }>(), fallback: 'newest' },
})
