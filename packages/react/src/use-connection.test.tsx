/**
 * State comes through `useSyncExternalStore`, and the two properties that matter are the
 * ones that are invisible until they are wrong: a stable return, and a server snapshot that
 * matches the client's first render.
 */
import { describe, expect, test } from 'bun:test'
import { act, render } from '@testing-library/react'
import { useState } from 'react'
import { renderToString } from 'react-dom/server'
import { Client, createServer } from 'transport-io'
import { loopbackPair } from 'transport-io/testing'
import { TransportProvider } from './context.tsx'
import { contract, settle, wire } from './harness.tsx'
import { useConnection } from './use-connection.ts'

describe('the returned object is referentially stable', () => {
  test('a re-render with no state change returns the same object', async () => {
    const { client, wrapper } = await wire()
    const seen: unknown[] = []
    let bump: ((n: number) => void) | undefined

    function Component(): null {
      const [, setN] = useState(0)
      bump = setN
      seen.push(useConnection())
      return null
    }

    render(<Component />, { wrapper })
    await act(async () => {
      bump?.(1)
    })
    await act(async () => {
      bump?.(2)
    })

    expect(seen.length).toBeGreaterThanOrEqual(3)
    // The same object across renders. A fresh one here is an infinite loop in anything
    // that puts this in a dependency array, and it is the defect core's own snapshot test
    // exists to prevent one layer down.
    expect(seen[seen.length - 1]).toBe(seen[seen.length - 2] as object)
    client.disconnect()
  })

  test('it returns a new object when the connection state actually changes', async () => {
    const { client, wrapper } = await wire()
    const seen: { status: string }[] = []

    function Component(): null {
      seen.push(useConnection())
      return null
    }
    render(<Component />, { wrapper })
    const before = seen[seen.length - 1]

    await act(async () => {
      client.disconnect()
      client.disconnect()
      await settle()
    })

    expect(seen[seen.length - 1]).not.toBe(before as object)
    expect(seen[seen.length - 1]?.status).toBe('closed')
  })
})

describe('server rendering', () => {
  test('reports idle, and touches no browser global', () => {
    const server = createServer({ contract })
    const [, clientSide] = loopbackPair()
    const client = new Client({ contract, connect: async () => clientSide })
    void server

    function Component(): string {
      const c = useConnection()
      return `${c.status}|${String(c.sessionId)}|${c.rooms.length}|${String(c.lastError)}`
    }

    // No act(), no effects: this is the server path, where effects never run.
    const html = renderToString(
      <TransportProvider client={client}>
        <Component />
      </TransportProvider>,
    )

    // Idle is the honest answer and the one that makes the server's HTML identical to the
    // client's first render, so hydration has nothing to reconcile.
    expect(html).toContain('idle')
    expect(html).toContain('null')
    expect(html).toContain('|0|')
  })
})
