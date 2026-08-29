'use client'
import { useCallback, useMemo, useSyncExternalStore } from 'react'
import type { ClientState } from 'transport-io'
import { useClient } from './context.tsx'

export interface Connection extends ClientState {
  readonly connect: () => Promise<void>
  readonly disconnect: () => void
}

/**
 * Connection state, and the two calls that change it.
 *
 * All state comes through `useSyncExternalStore`, which is what `subscribe` and
 * `getSnapshot` exist for. `getSnapshot` returns a referentially stable object, so this
 * hook's return is memoised on it rather than rebuilt: a fresh object per render would
 * re-render forever in anything that puts it in a dependency array.
 *
 * **During server rendering this reports `idle`**, because that is true - no connection
 * exists on a server - and because it makes the server's HTML identical to the client's
 * first render. The connect effect then drives the only transition, so there is no
 * hydration mismatch. Any other server value would produce one.
 */
export function useConnection(): Connection {
  const client = useClient()

  const subscribe = useCallback((onChange: () => void) => client.subscribe(onChange), [client])
  const snapshot = useCallback(() => client.getSnapshot(), [client])

  const state = useSyncExternalStore(subscribe, snapshot, snapshot)

  const connect = useCallback(() => client.connect(), [client])
  const disconnect = useCallback(() => {
    client.disconnect()
  }, [client])

  return useMemo(() => ({ ...state, connect, disconnect }), [state, connect, disconnect])
}
