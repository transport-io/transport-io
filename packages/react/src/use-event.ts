'use client'
import { useEffect, useEffectEvent } from 'react'
import type { Registered } from 'transport-io'
import { useClient } from './context.tsx'

/**
 * Subscribe to an event for as long as the component is mounted.
 *
 * The handler may be a fresh inline arrow on every render and the subscription still
 * happens once. `useEffectEvent` is the mechanism: it always sees the latest render's
 * handler, so the effect below does not need it as a dependency and therefore does not
 * resubscribe when it changes.
 *
 * Passing the Effect Event to `client.on` is the sanctioned shape, and the same one React's
 * own `useInterval` example uses with `setInterval`. The restriction is on passing Effect
 * Events to *components and Hooks*, and on calling them during render; `client.on` is a
 * plain subscription API called from inside an Effect.
 */
export function useEvent<K extends keyof Registered & string>(
  event: K,
  handler: (payload: Registered[K]['payload']) => void,
): void {
  const client = useClient()

  const onPayload = useEffectEvent(handler)

  useEffect(
    () => client.on(event, onPayload),
    // `onPayload` is deliberately absent. An Effect Event's identity changes on every
    // render by design, so listing it here would resubscribe on every render - which is
    // precisely the bug this hook exists to avoid. It looks like a missing dependency and
    // is the opposite of one.
    [client, event],
  )
}
