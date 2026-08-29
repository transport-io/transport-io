'use client'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { type AnyMap, type Registered, type StreamableOf, TransportError } from 'transport-io'
import { useClient } from './context.tsx'

/** `elements` is present in every state after the first, so a render never loses what arrived. */
export type StreamState<T> =
  | { readonly status: 'idle' }
  | { readonly status: 'streaming'; readonly elements: readonly T[] }
  | { readonly status: 'done'; readonly elements: readonly T[] }
  | {
      readonly status: 'error'
      readonly elements: readonly T[]
      readonly error: TransportError
    }

export interface UseStreamOptions<T> {
  /**
   * Called for each element as it arrives. Use it to render without accumulating: the
   * `elements` array grows for the life of the stream and a long generation is a long array.
   */
  readonly onElement?: (element: T) => void
}

export type UseStreamResult<M extends AnyMap, K extends StreamableOf<M> & string> = readonly [
  (payload: M[K]['payload']) => void,
  StreamState<M[K]['yields']>,
  () => void,
]

function asTransportError(e: unknown): TransportError {
  if (e instanceof TransportError) return e
  return new TransportError(
    'WT_HANDLER_ERROR',
    e instanceof Error ? e.message : String(e),
    'The stream rejected with something that was not a TransportError.',
  )
}

/**
 * A streaming response, accumulated.
 *
 * Unmounting cancels. That resets the QUIC stream, which fires the responder's `ctx.signal`
 * and runs any `finally` in its generator, so a component going away does not leave a
 * generator producing into nothing.
 */
export function useStream<K extends StreamableOf<Registered> & string>(
  event: K,
  options?: UseStreamOptions<Registered[K]['yields']>,
): UseStreamResult<Registered, K> {
  type T = Registered[K]['yields']
  const client = useClient()
  const [state, setState] = useState<StreamState<T>>({ status: 'idle' })

  const active = useRef<{ cancel: () => void } | null>(null)
  const mounted = useRef(true)
  const onElement = useRef(options?.onElement)
  onElement.current = options?.onElement

  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
      active.current?.cancel()
    }
  }, [])

  const stop = useCallback(() => {
    active.current?.cancel()
    active.current = null
  }, [])

  const start = useCallback(
    (payload: Registered[K]['payload']): void => {
      active.current?.cancel()
      const result = client.stream(event, payload)
      active.current = result
      /**
       * `elements` keeps its identity between renders because it is only ever replaced when
       * something is appended. Rebuilding it per render would break every consumer
       * memoising on it, which is the same defect class as `getSnapshot` handing back a new
       * object each call.
       */
      let elements: readonly T[] = []
      setState({ status: 'streaming', elements })

      void (async () => {
        try {
          for await (const element of result) {
            if (!mounted.current || active.current !== result) return
            onElement.current?.(element)
            elements = [...elements, element]
            setState({ status: 'streaming', elements })
          }
          if (mounted.current && active.current === result) {
            setState({ status: 'done', elements })
          }
        } catch (e) {
          if (!mounted.current || active.current !== result) return
          const error = asTransportError(e)
          // A cancellation is this hook's own doing, so it ends the stream rather than
          // failing it. Anything else is a real error the component should render.
          setState(
            error.code === 'WT_ABORTED'
              ? { status: 'done', elements }
              : { status: 'error', elements, error },
          )
        }
      })()
    },
    [client, event],
  )

  return useMemo(() => [start, state, stop] as const, [start, state, stop])
}
