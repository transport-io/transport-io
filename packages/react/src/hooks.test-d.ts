/**
 * The type surface, pinned.
 *
 * Two things here are easy to lose by accident. A tuple return degrades to a union array
 * the moment its annotation is dropped, which turns `const [call, state] = useCall(...)`
 * into `Fn | State` at both positions. And the wrong-event-name error is the message people
 * actually read, so it is pinned the way core pins its six.
 */
import { expectTypeOf } from 'expect-type'
import type { TransportError } from 'transport-io'
import type { CallState, UseCallResult } from './use-call.ts'
import { useCall } from './use-call.ts'
import type { useConnection } from './use-connection.ts'
import { useEvent } from './use-event.ts'
import type { StreamState, UseStreamResult } from './use-stream.ts'
import { useStream } from './use-stream.ts'
import './harness.tsx'

// --- tuples stay tuples ---

declare const callResult: UseCallResult<'save'>
expectTypeOf(callResult).toEqualTypeOf<
  readonly [(payload: { text: string }) => Promise<void>, CallState<{ n: number }>]
>()
// Positional, which is exactly what a union array would destroy.
expectTypeOf(callResult[0]).parameter(0).toEqualTypeOf<{ text: string }>()
expectTypeOf(callResult[1]).toEqualTypeOf<CallState<{ n: number }>>()

declare const streamResult: UseStreamResult<'ask'>
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
