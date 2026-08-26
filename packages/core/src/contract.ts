/**
 * The contract is the single source of truth. Reading `contract.ts` in an application
 * tells you every event, payload and lane without reading anything else.
 */
import type { StandardSchemaV1, StandardTypedV1 } from '@standard-schema/spec'
import { TransportError } from './errors.ts'
import { EVENT_ID_NOT_APPLICABLE } from './protocol.ts'

export type Lane = 'stream' | 'datagram'
export type Schema = StandardSchemaV1

/**
 * `returns` is meaningful only on the stream lane: a datagram has no response path.
 *
 * The `returns?: never` on the datagram branch is load-bearing, not decoration. Excess
 * property checking against a *union* admits any property present on any member, so
 * `{ lane: 'datagram', payload, returns }` compiled happily, `CallableOf` admitted it, and
 * `call()` served it over a bidirectional stream. A contract that says "may be dropped"
 * produced a guaranteed ordered message with the type system agreeing — a direct violation
 * of D1, the first decision this project made.
 */
export type EventDef =
  | {
      readonly lane: 'datagram'
      readonly payload: Schema
      readonly id?: number
      readonly returns?: never
    }
  | {
      readonly lane: 'stream'
      readonly payload: Schema
      readonly returns?: Schema
      readonly id?: number
    }

export type Contract = Readonly<Record<string, EventDef>>

export type Infer<S extends StandardTypedV1> = StandardTypedV1.InferOutput<S>

/**
 * The plain payload/returns map every public signature is written against, so that no
 * method hover ever has to print a validator's internal types. See D57 — declaring
 * `interface AppMap extends MapOf<typeof contract> {}` is what keeps hover at 126
 * characters instead of 303.
 */
export type MapOf<C extends Contract> = {
  readonly [K in keyof C]: {
    readonly payload: Infer<C[K]['payload']>
    readonly returns: C[K] extends { readonly returns: infer R extends Schema }
      ? Infer<R>
      : never
  }
}

export interface EventShape {
  readonly payload: unknown
  readonly returns: unknown
}
export type AnyMap = Readonly<Record<string, EventShape>>

/** Events declaring `returns`, and therefore callable. */
export type CallableOf<M extends AnyMap> = {
  [K in keyof M]: [M[K]['returns']] extends [never] ? never : K
}[keyof M]

export function defineContract<const C extends Contract>(contract: C): C {
  return contract
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
 * PROTOCOL.md §5.4 — the first four bytes of SHA-256 of the event name, big-endian.
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
