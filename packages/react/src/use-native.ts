'use client'
import { useCallback, useSyncExternalStore } from 'react'
import type { NativeLanes, Registered } from 'transport-io'
import { useClient } from './context.tsx'

/**
 * `call()` and `stream()` as the current session carries them, or `null`.
 *
 * For a plain client this is the client. For one built with `withFallback` it is `native`:
 * `null` on a fallback session and before connecting, the client on a native session, and
 * it re-renders when that changes, which `client.native` read once during a render would not.
 * `useCall` and `useStream` are the same decision made for you; this is for anything else.
 */
export function useNative(): NativeLanes<Registered> | null {
  const client = useClient()
  const subscribe = useCallback((onChange: () => void) => client.subscribe(onChange), [client])
  // The getter on a fallback client reads the snapshot, so it changes exactly when this store
  // does, and it returns the client object itself, which keeps the value referentially stable.
  return useSyncExternalStore(
    subscribe,
    () => ('native' in client ? client.native : client),
    () => null,
  )
}
