/**
 * The contract is the single source of truth. Reading `contract.ts` in an application
 * tells you every event, payload and lane without reading anything else.
 */
import type { StandardSchemaV1, StandardTypedV1 } from '@standard-schema/spec'
import { TransportError } from './errors.ts'
import { EVENT_ID_NOT_APPLICABLE } from './protocol.ts'

export type Lane = 'reliable' | 'unreliable'
export type Schema = StandardSchemaV1

/**
 * `returns` is meaningful only on the reliable lane: an unreliable event has no response
 * path. `yields` is the streaming form of `returns` and excludes it: an event answers with
 * one value or with a sequence, never with a choice made at the call site.
 *
 * The choice cannot be per call site, and the reason is on the wire rather than in taste. A
 * handler that yields nothing closes the stream with zero CALL_RESPONSE frames, which is
 * exactly the byte sequence a `call()` responder produces when it is broken. Identical
 * bytes, two meanings: a protocol error for `call()`, a clean empty iteration for
 * `stream()`. Only the contract, which both peers exchange at handshake, tells them apart.
 *
 * The `returns?: never` on the datagram branch does real work. Excess
 * property checking against a *union* admits any property present on any member, so
 * `{ lane: 'unreliable', payload, returns }` compiled happily, `CallableOf` admitted it, and
 * `call()` served it over a bidirectional stream. A contract that says "may be dropped"
 * produced a guaranteed ordered message with the type system agreeing - a direct violation
 * of D1, the first decision this project made.
 */
export type EventDef =
  | {
      readonly lane: 'unreliable'
      readonly payload: Schema
      readonly id?: number
      readonly returns?: never
      readonly yields?: never
    }
  | {
      readonly lane: 'reliable'
      readonly payload: Schema
      readonly returns?: Schema
      readonly id?: number
      readonly yields?: never
    }
  | {
      readonly lane: 'reliable'
      readonly payload: Schema
      readonly yields: Schema
      readonly id?: number
      readonly returns?: never
    }

export type Contract = Readonly<Record<string, EventDef>>

export type Infer<S extends StandardTypedV1> = StandardTypedV1.InferOutput<S>

/**
 * The plain payload/returns map every public signature is written against, so that no
 * method hover ever has to print a validator's internal types. See D57 - declaring
 * `interface AppMap extends MapOf<typeof contract> {}` is what keeps hover at 126
 * characters instead of 303.
 */
export type MapOf<C extends Contract> = {
  readonly [K in keyof C]: {
    readonly payload: Infer<C[K]['payload']>
    readonly returns: C[K] extends { readonly returns: infer R extends Schema }
      ? Infer<R>
      : never
    readonly yields: C[K] extends { readonly yields: infer Y extends Schema } ? Infer<Y> : never
  }
}

export interface EventShape {
  readonly payload: unknown
  readonly returns: unknown
  readonly yields: unknown
}
export type AnyMap = Readonly<Record<string, EventShape>>

/**
 * Augmented by the application to register its contract once:
 *
 * ```ts
 * declare module 'transport-io' {
 *   interface Register {
 *     map: AppMap
 *   }
 * }
 * ```
 *
 * It holds the **map**, not the contract, and that is measured rather than stylistic.
 * Resolving the map through a conditional over the contract is an alias instantiation, and
 * TypeScript expands those while preserving interface names: hover on `emit` goes from 107
 * characters to 377, with the validator's internals back in it. See D100.
 */
export type Register = {}

/**
 * The sentinel for an unregistered application. Its only key is the instruction, so the
 * first `emit` fails with `Argument of type '"chat"' is not assignable to parameter of type
 * '"no contract registered: ..."'`.
 *
 * It must be a **type alias, not an interface**. Interfaces get no implicit index signature,
 * so an interface here fails the `AnyMap` constraint and produces a second, confusing error
 * next to the useful one. The next person to touch this will try the interface.
 */
type NoContractRegistered = {
  readonly 'no contract registered: declare module "transport-io" { interface Register { map: AppMap } }': {
    readonly payload: never
    readonly returns: never
    readonly yields: never
  }
}

/** The registered map, or the sentinel that explains how to register one. */
export type Registered = Register extends { map: infer M extends AnyMap }
  ? M
  : NoContractRegistered

/** Events declaring `returns`, and therefore callable. */
export type CallableOf<M extends AnyMap> = {
  [K in keyof M]: [M[K]['returns']] extends [never] ? never : K
}[keyof M]

/** Events declaring `yields`, and therefore streamable. Disjoint from `CallableOf`. */
export type StreamableOf<M extends AnyMap> = {
  [K in keyof M]: [M[K]['yields']] extends [never] ? never : K
}[keyof M]

/**
 * `unknown` and `any` both satisfy `unknown extends T`, so the `any` check runs first. An
 * event whose payload is deliberately untyped writes `any` and says so at the call site.
 */
type IsAny<T> = 0 extends 1 & T ? true : false
type IsUnknown<T> = IsAny<T> extends true ? false : unknown extends T ? true : false

/**
 * Replaces any event whose payload infers `unknown` with a sentence, so the error lands on
 * the offending property inside the contract literal and names the event.
 *
 * `reliable()` with no type argument and no schema infers `unknown`, which would otherwise
 * compile and accept anything for the rest of the application's life. The check lives here
 * rather than at `emit()` because this is where the mistake is, and where someone is
 * looking when they make it.
 *
 * Taken as the parameter type rather than intersected with `C`: the intersection produces a
 * three-line error repeating the object type, this produces one line.
 */
export type CheckPayloads<C extends Contract> = {
  [K in keyof C]: IsUnknown<Infer<C[K]['payload']>> extends true
    ? `event '${K & string}' has an unknown payload: pass a type argument or a schema`
    : C[K]
}

export function defineContract<const C extends Contract>(contract: CheckPayloads<C>): C {
  return contract as unknown as C
}

/**
 * Sugar over the object literal. The literal keeps working, and anything generating a
 * contract programmatically needs it, so these add nothing the literal cannot express.
 *
 * Each takes either a type argument or a Standard Schema, because validation is
 * bring-your-own and must not become second class. `id` is reached by spreading:
 * `{ ...reliable<T>(), id: 0x31e06f7d }`.
 *
 * `rpc` and `streaming` are reliable by construction. An unreliable event has no response
 * path, so the lane is not a parameter and the combination stops being expressible.
 */
export function reliable<T>(): {
  readonly lane: 'reliable'
  readonly payload: StandardSchemaV1<unknown, T>
}
export function reliable<S extends Schema>(
  schema: S,
): { readonly lane: 'reliable'; readonly payload: S }
export function reliable(schema?: Schema): {
  readonly lane: 'reliable'
  readonly payload: Schema
} {
  return { lane: 'reliable', payload: schema ?? type$<unknown>() }
}

export function unreliable<T>(): {
  readonly lane: 'unreliable'
  readonly payload: StandardSchemaV1<unknown, T>
}
export function unreliable<S extends Schema>(
  schema: S,
): { readonly lane: 'unreliable'; readonly payload: S }
export function unreliable(schema?: Schema): {
  readonly lane: 'unreliable'
  readonly payload: Schema
} {
  return { lane: 'unreliable', payload: schema ?? type$<unknown>() }
}

export function rpc<P, R>(): {
  readonly lane: 'reliable'
  readonly payload: StandardSchemaV1<unknown, P>
  readonly returns: StandardSchemaV1<unknown, R>
}
export function rpc<P extends Schema, R extends Schema>(
  payload: P,
  returns: R,
): { readonly lane: 'reliable'; readonly payload: P; readonly returns: R }
export function rpc(
  payload?: Schema,
  returns?: Schema,
): { readonly lane: 'reliable'; readonly payload: Schema; readonly returns: Schema } {
  return {
    lane: 'reliable',
    payload: payload ?? type$<unknown>(),
    returns: returns ?? type$<unknown>(),
  }
}

export function streaming<P, Y>(): {
  readonly lane: 'reliable'
  readonly payload: StandardSchemaV1<unknown, P>
  readonly yields: StandardSchemaV1<unknown, Y>
}
export function streaming<P extends Schema, Y extends Schema>(
  payload: P,
  yields: Y,
): { readonly lane: 'reliable'; readonly payload: P; readonly yields: Y }
export function streaming(
  payload?: Schema,
  yields?: Schema,
): { readonly lane: 'reliable'; readonly payload: Schema; readonly yields: Schema } {
  return {
    lane: 'reliable',
    payload: payload ?? type$<unknown>(),
    yields: yields ?? type$<unknown>(),
  }
}

/** A types-only schema, for inference without runtime validation. */
export function type$<T>(): StandardSchemaV1<unknown, T> {
  return {
    '~standard': {
      version: 1,
      vendor: 'transport-io',
      validate: (value: unknown) => ({ value: value as T }),
    },
  }
}

// ---------------------------------------------------------------- the wire event table

export interface EventEntry {
  readonly name: string
  readonly id: number
  readonly lane: Lane
  readonly def: EventDef
}

export interface EventTable {
  readonly entries: readonly EventEntry[]
  byName(name: string): EventEntry | undefined
  byId(id: number): EventEntry | undefined
  /** The `[name, id, lane]` triples the handshake carries. PROTOCOL.md §4.3. */
  wire(): readonly [string, number, Lane][]
}

/**
 * PROTOCOL.md §5.4 - the first four bytes of SHA-256 of the event name, big-endian.
 *
 * Async because `crypto.subtle` is, and because writing SHA-256 by hand would mean typing
 * its round constants from memory, which is the one thing D58 forbids. Both `connect()`
 * and `listen()` are already async, so the table is built once at session start.
 */
export async function eventIdOf(name: string): Promise<number> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(name))
  return new DataView(digest).getUint32(0, false)
}

export async function buildEventTable(contract: Contract): Promise<EventTable> {
  const names = Object.keys(contract).sort()
  const entries: EventEntry[] = []
  const byId = new Map<number, EventEntry>()
  const byName = new Map<string, EventEntry>()

  for (const name of names) {
    const def = contract[name] as EventDef
    const id = def.id ?? (await eventIdOf(name))
    if (id === EVENT_ID_NOT_APPLICABLE) {
      throw new TransportError(
        'WT_CONTRACT_MISMATCH',
        `event '${name}' resolves to the reserved id 0`,
        'Set an explicit `id` on this event. Zero is reserved for frames whose meaning comes from the stream.',
      )
    }
    const clash = byId.get(id)
    if (clash !== undefined) {
      throw new TransportError(
        'WT_CONTRACT_MISMATCH',
        `events '${clash.name}' and '${name}' both hash to id ${id}`,
        `Set an explicit \`id\` on one of them, for example { ..., id: ${id + 1} }. Do not rename your events.`,
      )
    }
    const entry: EventEntry = { name, id, lane: def.lane, def }
    entries.push(entry)
    byId.set(id, entry)
    byName.set(name, entry)
  }

  return {
    entries,
    byName: (n) => byName.get(n),
    byId: (i) => byId.get(i),
    wire: () => entries.map((e) => [e.name, e.id, e.lane] as [string, number, Lane]),
  }
}
