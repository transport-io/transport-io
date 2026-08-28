/**
 * The contract helpers, at the type level.
 *
 * These are sugar over the object literal and must stay sugar: anything the literal can
 * express, the helpers express, and the literal keeps working beside them. The tests that
 * matter here are the ones asserting a wrong use produces a readable error, since a helper
 * that trades a clear failure for a shorter call site is a bad trade.
 *
 * Error text is pinned with `@ts-expect-error` plus an assertion on the resulting type,
 * because `@ts-expect-error` alone passes for any error at all, including one arriving for
 * the wrong reason.
 */
import { expectTypeOf } from 'expect-type'
import {
  defineContract,
  type Infer,
  type MapOf,
  reliable,
  rpc,
  streaming,
  type$,
  unreliable,
} from './contract.ts'

// --- the four helpers produce the same shapes the literal does ---

const contract = defineContract({
  chat: reliable<{ room: string; body: string }>(),
  cursor: unreliable<{ x: number; y: number }>(),
  save: rpc<{ text: string }, { revision: number }>(),
  ask: streaming<{ prompt: string }, string>(),
})
interface AppMap extends MapOf<typeof contract> {}

expectTypeOf<AppMap['chat']['payload']>().toEqualTypeOf<{ room: string; body: string }>()
expectTypeOf<AppMap['cursor']['payload']>().toEqualTypeOf<{ x: number; y: number }>()
expectTypeOf<AppMap['save']['returns']>().toEqualTypeOf<{ revision: number }>()
expectTypeOf<AppMap['ask']['yields']>().toEqualTypeOf<string>()

// The lanes are fixed by the helper, not inferred from a literal.
expectTypeOf(contract.chat.lane).toEqualTypeOf<'reliable'>()
expectTypeOf(contract.cursor.lane).toEqualTypeOf<'unreliable'>()
expectTypeOf(contract.save.lane).toEqualTypeOf<'reliable'>()
expectTypeOf(contract.ask.lane).toEqualTypeOf<'reliable'>()

// --- a Standard Schema is accepted anywhere a type argument is ---

const schema = type$<{ body: string }>()
const bySchema = defineContract({
  chat: reliable(schema),
  cursor: unreliable(schema),
  save: rpc(schema, type$<{ n: number }>()),
  ask: streaming(schema, type$<string>()),
})
interface SchemaMap extends MapOf<typeof bySchema> {}
expectTypeOf<SchemaMap['chat']['payload']>().toEqualTypeOf<{ body: string }>()
expectTypeOf<SchemaMap['save']['returns']>().toEqualTypeOf<{ n: number }>()
expectTypeOf<SchemaMap['ask']['yields']>().toEqualTypeOf<string>()

// --- the literal keeps working, and mixes with helpers ---

const mixed = defineContract({
  fromHelper: reliable<{ a: number }>(),
  fromLiteral: { lane: 'reliable', payload: type$<{ b: number }>() },
})
interface MixedMap extends MapOf<typeof mixed> {}
expectTypeOf<MixedMap['fromLiteral']['payload']>().toEqualTypeOf<{ b: number }>()

// --- `id` stays reachable, by spreading ---

const withId = defineContract({
  chat: { ...reliable<{ a: number }>(), id: 0x31e06f7d },
})
// `const` inference keeps the literal, which is what the collision check reads.
expectTypeOf(withId.chat.id).toEqualTypeOf<0x31e06f7d>()

// --- an unknown payload is refused, in the contract, naming the event ---

defineContract({
  // @ts-expect-error event 'oops' has an unknown payload: pass a type argument or a schema
  oops: reliable(),
})

defineContract({
  // @ts-expect-error event 'alsoBad' has an unknown payload: pass a type argument or a schema
  alsoBad: { lane: 'reliable', payload: type$() },
})

// `any` is the deliberate escape, and it is opt-in and visible at the call site. The rule
// forbidding `any` is suspended here precisely because this asserts that `any` works.
// biome-ignore lint/suspicious/noExplicitAny: the escape hatch is the subject of this test
const escaped = defineContract({ raw: reliable<any>() })
expectTypeOf<Infer<(typeof escaped)['raw']['payload']>>().toBeAny()

// --- combinations the helpers make unexpressible ---

// An unreliable event cannot declare a response, because there is no response path.
expectTypeOf(unreliable<{ x: number }>()).not.toHaveProperty('returns')
expectTypeOf(unreliable<{ x: number }>()).not.toHaveProperty('yields')
// `rpc` and `streaming` are reliable by construction; the lane is not a parameter.
expectTypeOf(rpc<{ a: number }, { b: number }>().lane).toEqualTypeOf<'reliable'>()
expectTypeOf(streaming<{ a: number }, string>().lane).toEqualTypeOf<'reliable'>()
