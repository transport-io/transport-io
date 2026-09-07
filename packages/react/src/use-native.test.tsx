/**
 * `useNative`: the lanes a session carries, as a value a render can branch on, following
 * the session rather than the type of the client.
 */
import { describe, expect, test } from 'bun:test'
import { render } from '@testing-library/react'
import { wire, wireFallback } from './harness.tsx'
import { useNative } from './use-native.ts'

describe('useNative', () => {
  test('is the client itself for a plain client', async () => {
    const { client, wrapper } = await wire()
    let seen: unknown = 'unset'
    function Component(): null {
      seen = useNative()
      return null
    }
    render(<Component />, { wrapper })
    expect(seen).toBe(client)
    client.disconnect()
  })

  test('is null on a fallback session, where there is nothing to call', async () => {
    const { client, wrapper } = await wireFallback()
    let seen: unknown = 'unset'
    function Component(): null {
      seen = useNative()
      return null
    }
    render(<Component />, { wrapper })
    expect(seen).toBeNull()
    client.disconnect()
  })
})
