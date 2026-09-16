'use client'
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import { type AnyMap, type CallableOf, type Registered, TransportError } from 'transport-io'
import { callable, useClient } from './context.tsx'

/**
 * A union rather than independent flags.
 *
 * With flags, `data` is `R | undefined` and every consumer narrows it by hand, while
 * `pending` and `error` can both be true at once. Checking `status` here narrows `data`
 * automatically, and the impossible combinations cannot be written down.
 */
export type CallState<R> =
  | { readonly status: 'idle' }
  | { readonly status: 'pending' }
  | { readonly status: 'error'; readonly error: TransportError }
  | { readonly status: 'success'; readonly data: R }
  /**
   * The session is on a fallback transport, which has no streams to carry a call. Reported
   * before anything is asked, and only by a client built with `withFallback`.
   */
  | { readonly status: 'unavailable' }

const UNAVAILABLE: { readonly status: 'unavailable' } = Object.freeze({ status: 'unavailable' })

export interface UseCallOptions {
  /**
   * Abort an in-flight call when the component unmounts. On by default: an unmounted
   * component's answer goes nowhere, and aborting is a QUIC stream reset that costs no
   * application message.
   *
   * Pass `false` when the call has a server-side effect that must complete regardless of
   * whether anyone is still watching.
   */
  readonly abortOnUnmount?: boolean
}

/**
 * The function resolves to the answer, the way TanStack Query's `mutateAsync` does, so a
 * caller that wants the value right away has it without reading hook state; the state is
 * updated as well. It rejects with the `TransportError` on failure, with `WT_ABORTED` when
 * the call was superseded or the component unmounted, and with `WT_LANE_UNAVAILABLE` on a
 * fallback session. A caller that ignores the promise sees the failure in `state` and never
 * an unhandled rejection: the hook observes its own promise.
 */
export type UseCallResult<M extends AnyMap, K extends CallableOf<M> & string> = readonly [
  (payload: M[K]['payload']) => Promise<M[K]['returns']>,
  CallState<M[K]['returns']>,
]

function asTransportError(e: unknown): TransportError {
  if (e instanceof TransportError) return e
  return new TransportError(
    'WT_HANDLER_ERROR',
    e instanceof Error ? e.message : String(e),
    'The call rejected with something that was not a TransportError.',
  )
}

function laneUnavailable(): TransportError {
  return new TransportError(
    'WT_LANE_UNAVAILABLE',
    'call() needs a WebTransport session, and this one is on a WebSocket',
    'The state already reports unavailable; check it before asking. Emits still work here.',
  )
}

function aborted(why: string): TransportError {
  return new TransportError(
    'WT_ABORTED',
    `the call was ${why}`,
    'Nothing to retry: the hook aborted this call on purpose.',
  )
}

/** Request and response, with the state a component actually renders. */
export function useCall<K extends CallableOf<Registered> & string>(
  event: K,
  options?: UseCallOptions,
): UseCallResult<Registered, K> {
  const client = useClient()
  const [state, setState] = useState<CallState<Registered[K]['returns']>>({ status: 'idle' })
  const abortOnUnmount = options?.abortOnUnmount ?? true

  // Availability follows the session, so a component knows before it asks and forgets when
  // a reconnect lands on the native transport again.
  const subscribe = useCallback((onChange: () => void) => client.subscribe(onChange), [client])
  const transport = useSyncExternalStore(
    subscribe,
    () => client.getSnapshot().transport,
    () => null,
  )
  const unavailable = transport === 'websocket'

  const inFlight = useRef<AbortController | null>(null)
  const mounted = useRef(true)

  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
      if (abortOnUnmount) inFlight.current?.abort()
    }
  }, [abortOnUnmount])

  const invoke = useCallback(
    (payload: Registered[K]['payload']): Promise<Registered[K]['returns']> => {
      // The state already says so; there is nothing to ask and nothing to report twice.
      if (client.getSnapshot().transport === 'websocket') {
        return Promise.reject(laneUnavailable())
      }
      // A second call supersedes the first: rendering two answers at once is not a state
      // this union can hold, and the newer one is the one the user asked for.
      inFlight.current?.abort()
      const controller = new AbortController()
      inFlight.current = controller
      setState({ status: 'pending' })
      const run = (async (): Promise<Registered[K]['returns']> => {
        try {
          const data = await callable(client).call(event, payload, {
            signal: controller.signal,
          })
          if (mounted.current && inFlight.current === controller) {
            setState({ status: 'success', data })
          }
          return data
        } catch (e) {
          // An abort is this hook's own doing, on unmount or on being superseded. Reporting
          // it as an error would put a failure on screen that nobody caused; the promise
          // still says so, since an awaiter must not hang.
          if (controller.signal.aborted) {
            throw aborted(
              mounted.current ? 'superseded by a newer call' : 'abandoned on unmount',
            )
          }
          const error = asTransportError(e)
          if (mounted.current && inFlight.current === controller) {
            setState({ status: 'error', error })
          }
          throw error
        }
      })()
      // Observed here, so a caller that fires and forgets reads the failure from the state
      // and never from an unhandled rejection. An awaiter still gets the rejection.
      run.catch(() => undefined)
      return run
    },
    [client, event],
  )

  const shown = unavailable ? UNAVAILABLE : state
  return useMemo(() => [invoke, shown] as const, [invoke, shown])
}
