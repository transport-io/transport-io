/**
 * The resubscription guarantee, which is the reason this hook exists.
 *
 * A handler passed inline is a new function on every render. If the subscription depended on
 * it, every render would unsubscribe and resubscribe - and on a component rendering at frame
 * rate that is a subscription churn nobody asked for. `useEffectEvent` makes the handler
 * stable to the effect while still seeing the latest render's closure.
 */
import { describe, expect, test } from 'bun:test'
import { act, render } from '@testing-library/react'
import { useState } from 'react'
import { settle, wire } from './harness.tsx'
import { useEvent } from './use-event.ts'

describe('a re-render does not churn the subscription', () => {
  test('50 renders with a fresh inline handler subscribe exactly once', async () => {
    const { client, wrapper } = await wire()

    let subscribes = 0
    let unsubscribes = 0
    const realOn = client.on.bind(client)
    // Counting at the client rather than trusting a render count: this is the actual
    // resource that would leak.
    ;(client as unknown as { on: typeof client.on }).on = ((event, handler) => {
      subscribes++
      const off = realOn(event, handler as never)
      return () => {
        unsubscribes++
        off()
      }
    }) as typeof client.on

    let setTick: ((n: number) => void) | undefined
    function Component(): null {
      const [, set] = useState(0)
      setTick = set
      // A fresh arrow every render, which is what a user writes.
      useEvent('chat', (payload) => void payload.body)
      return null
    }

    render(<Component />, { wrapper })
    expect(subscribes).toBe(1)

    for (let i = 1; i <= 50; i++) {
      await act(async () => {
        setTick?.(i)
      })
    }

    expect(subscribes).toBe(1)
    expect(unsubscribes).toBe(0)
    client.disconnect()
  })

  test('the handler that fires is the newest one, not the one captured first', async () => {
    const { client, peer, wrapper } = await wire()
    const seen: number[] = []
    let bump: ((n: number) => void) | undefined

    function Component(): null {
      const [n, setN] = useState(0)
      bump = setN
      // Closes over `n`. Without an Effect Event this would keep reporting 0 forever.
      useEvent('chat', () => seen.push(n))
      return null
    }

    render(<Component />, { wrapper })
    await act(async () => {
      bump?.(7)
    })

    // Pushed from the server, which is the only direction that reaches a client handler.
    await act(async () => {
      peer.emit('chat', { body: 'from server' })
      await settle()
    })

    expect(n_or(seen)).toBe(7)
    client.disconnect()
  })
})

/** The last value seen, or -1 when nothing arrived, so a silent miss fails loudly. */
function n_or(seen: readonly number[]): number {
  return seen.length === 0 ? -1 : (seen[seen.length - 1] as number)
}
