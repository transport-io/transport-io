'use client'
/**
 * Hooks bound to one contract, without registering it globally.
 *
 * Everywhere else in this library the map is passed explicitly - `new Client<AppMap>(…)` -
 * because the type then follows the import rather than the load order, and two contracts in
 * one process are simply two types. The hooks could not do that: they read the globally
 * registered map, so the React binding was the only path that required
 * `declare module 'transport-io'`.
 *
 * This closes that. `createHooks<AppMap>()` hands back the same hooks typed for one map, and
 * is the same shape tRPC uses for the same reason.
 *
 * Measured, because the interface line is what makes it work: `api.useEvent` hovers at 129
 * characters against 123 for the registered form, and 116 when destructured. Handing
 * `MapOf<typeof contract>` in directly instead of a named interface takes it to 411, which is
 * the alias expansion this project has now measured three times.
 */
import type { AnyMap, CallableOf, Client, StreamableOf } from 'transport-io'
import { useClient } from './context.tsx'
import { type UseCallOptions, type UseCallResult, useCall } from './use-call.ts'
import { type Connection, useConnection } from './use-connection.ts'
import { useEvent } from './use-event.ts'
import { type UseStreamOptions, type UseStreamResult, useStream } from './use-stream.ts'

export interface Hooks<M extends AnyMap> {
  useClient(): Client<M>
  useConnection(): Connection
  useEvent<K extends keyof M & string>(
    event: K,
    handler: (payload: M[K]['payload']) => void,
  ): void
  useCall<K extends CallableOf<M> & string>(
    event: K,
    options?: UseCallOptions,
  ): UseCallResult<M, K>
  useStream<K extends StreamableOf<M> & string>(
    event: K,
    options?: UseStreamOptions<M[K]['yields']>,
  ): UseStreamResult<M, K>
}

/**
 * The hooks, typed for one contract.
 *
 * ```ts
 * export const api = createHooks<AppMap>()
 * ```
 *
 * The cast is the whole implementation and it is honest: `M` exists only in the types. Every
 * hook below is the same function the named exports are, and none of them reads the map at
 * runtime - the client does, from the contract it was constructed with. What the type
 * parameter changes is which event names and payloads the compiler accepts.
 */
export function createHooks<M extends AnyMap>(): Hooks<M> {
  return { useClient, useConnection, useEvent, useCall, useStream } as unknown as Hooks<M>
}
