/**
 * The type surface, pinned.
 *
 * Two things here are easy to lose by accident. A tuple return degrades to a union array
 * the moment its annotation is dropped, which turns `const [call, state] = useCall(...)`
 * into `Fn | State` at both positions. And the wrong-event-name error is the message people
 * actually read, so it is pinned the way core pins its six.
 */
import { expectTypeOf } from 'expect-type'
import { defineContract, type MapOf, reliable, type TransportError } from 'transport-io'
import type { TestMap } from './harness.tsx'
import type { CallState, UseCallResult } from './use-call.ts'
import { useCall } from './use-call.ts'
import type { useConnection } from './use-connection.ts'
import { useEvent } from './use-event.ts'
import type { StreamState, UseStreamResult } from './use-stream.ts'
import { useStream } from './use-stream.ts'

// --- tuples stay tuples ---

declare const callResult: UseCallResult<TestMap, 'save'>
expectTypeOf(callResult).toEqualTypeOf<
  readonly [(payload: { text: string }) => Promise<void>, CallState<{ n: number }>]
>()
// Positional, which is exactly what a union array would destroy.
expectTypeOf(callResult[0]).parameter(0).toEqualTypeOf<{ text: string }>()
expectTypeOf(callResult[1]).toEqualTypeOf<CallState<{ n: number }>>()

declare const streamResult: UseStreamResult<TestMap, 'ask'>
expectTypeOf(streamResult).toEqualTypeOf<
  readonly [(payload: { prompt: string }) => void, StreamState<string>, () => void]
>()
expectTypeOf(streamResult[2]).toEqualTypeOf<() => void>()

// --- the union narrows, so impossible states cannot be written ---

declare const state: CallState<{ n: number }>
if (state.status === 'success') {
  // `data` exists here and nowhere else.
  expectTypeOf(state.data).toEqualTypeOf<{ n: number }>()
}
if (state.status === 'error') {
  expectTypeOf(state.error).toEqualTypeOf<TransportError>()
}
// @ts-expect-error `data` is not present on the pending branch
expectTypeOf(({ status: 'pending' } as CallState<number>).data)

declare const sstate: StreamState<string>
if (sstate.status !== 'idle') {
  // Present in streaming, done and error alike, so a render never loses what arrived.
  expectTypeOf(sstate.elements).toEqualTypeOf<readonly string[]>()
}

// --- wrong event names read as one line naming the valid events ---
//
// Inside a component, because hooks may only be called from one and the lint rule that
// enforces that does not know this file is never executed.
export function WrongNames(): null {
  // @ts-expect-error 'chatt' is not an event in the registered contract
  useEvent('chatt', () => {})

  // @ts-expect-error 'chat' declares no `returns`, so it is not callable
  useCall('chat')

  // @ts-expect-error 'save' declares `returns`, not `yields`, so it is not streamable
  useStream('save')

  // @ts-expect-error the payload shape comes from the contract
  useEvent('chat', (p: { wrong: true }) => void p)

  return null
}

// --- the connection object carries the snapshot plus the two calls ---

declare const conn: ReturnType<typeof useConnection>
expectTypeOf(conn.status).toEqualTypeOf<
  'idle' | 'connecting' | 'connected' | 'closing' | 'closed'
>()
expectTypeOf(conn.rooms).toEqualTypeOf<readonly string[]>()
expectTypeOf(conn.connect).toEqualTypeOf<() => Promise<void>>()
expectTypeOf(conn.disconnect).toEqualTypeOf<() => void>()

// --- createHooks: the same types, bound to a map rather than to a registration ---

import { createHooks } from './create-hooks.ts'

const api = createHooks<TestMap>()

// Destructuring keeps the types, which is how most people will use it.
const { useEvent: onEvent } = createHooks<TestMap>()

// A second contract in the same file, which is the thing registration cannot do.
const otherContract = defineContract({ ping: reliable<{ seq: number }>() })
interface OtherMap extends MapOf<typeof otherContract> {}
const other = createHooks<OtherMap>()

// Inside a component, because hooks may only be called from one.
export function FactoryTypes(): null {
  api.useEvent('chat', (p) => {
    expectTypeOf(p).toEqualTypeOf<{ body: string }>()
  })
  expectTypeOf(api.useCall('save')).toEqualTypeOf<UseCallResult<TestMap, 'save'>>()
  expectTypeOf(api.useStream('ask')).toEqualTypeOf<UseStreamResult<TestMap, 'ask'>>()

  // @ts-expect-error 'chatt' is not an event in this contract
  api.useEvent('chatt', () => {})

  // @ts-expect-error 'chat' declares no `returns`, so it is not callable
  api.useCall('chat')

  onEvent('chat', (p) => {
    expectTypeOf(p).toEqualTypeOf<{ body: string }>()
  })

  other.useEvent('ping', (p) => {
    expectTypeOf(p).toEqualTypeOf<{ seq: number }>()
  })
  // @ts-expect-error the two maps do not bleed into each other
  other.useEvent('chat', () => {})

  return null
}
