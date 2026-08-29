/**
 * StrictMode mounts, unmounts and remounts every component in development.
 *
 * Core's `connect` and `disconnect` are refcounted, so this is safe - but "safe" is not the
 * same as "invisible", and this test pins what actually happens rather than asserting the
 * comfortable version. The provider's refcount goes 1 -> 0 -> 1, and at zero the session
 * genuinely tears down and is rebuilt.
 *
 * That is one wasted connection cycle, in development only. The alternative - deferring
 * `disconnect` behind a timer so the remount reuses the session - would trade a visible
 * dev-only reconnect for an invisible race in production, which is a bad trade.
 */
import { describe, expect, test } from 'bun:test'
import { act, render } from '@testing-library/react'
import { StrictMode } from 'react'
import { Client, createServer } from 'transport-io'
import { loopbackPair } from 'transport-io/testing'
import { TransportProvider } from './context.tsx'
import { contract, settle } from './harness.tsx'
import { useConnection } from './use-connection.ts'
import { useEvent } from './use-event.ts'

describe('double mounting', () => {
  test('the client ends up connected, and connect/disconnect are balanced', async () => {
    const server = createServer({ contract })
    await server.listen()
    // A fresh connection per call, because that is what a real transport does and what a
    // reconnect requires. StrictMode's discarded mount closes the first session, so a
    // factory returning one fixed connection would hand back a closed one and hang.
    const connect = async (): Promise<never> => {
      const [serverSide, clientSide] = loopbackPair()
      void server.accept(serverSide)
      return clientSide as never
    }
    const client = new Client({ contract, connect })

    let connects = 0
    let disconnects = 0
    const realConnect = client.connect.bind(client)
    const realDisconnect = client.disconnect.bind(client)
    ;(client as unknown as { connect: () => Promise<void> }).connect = async () => {
      connects++
      await realConnect()
    }
    ;(client as unknown as { disconnect: () => void }).disconnect = () => {
      disconnects++
      realDisconnect()
    }

    let status = ''
    function Component(): null {
      status = useConnection().status
      return null
    }

    await act(async () => {
      render(
        <StrictMode>
          <TransportProvider client={client}>
            <Component />
          </TransportProvider>
        </StrictMode>,
      )
      await settle(40)
    })

    // The measured behaviour: StrictMode runs the effect twice, so both calls happen twice.
    // They are balanced, which is what refcounting buys.
    expect(connects).toBe(2)
    expect(disconnects).toBe(1)
    expect(status).toBe('connected')
    client.disconnect()
  })

  test('a subscription is not left behind by the discarded mount', async () => {
    const server = createServer({ contract })
    await server.listen()
    const connect = async (): Promise<never> => {
      const [serverSide, clientSide] = loopbackPair()
      void server.accept(serverSide)
      return clientSide as never
    }
    const client = new Client({ contract, connect })

    let live = 0
    const realOn = client.on.bind(client)
    ;(client as unknown as { on: typeof client.on }).on = ((event, handler) => {
      live++
      const off = realOn(event, handler as never)
      return () => {
        live--
        off()
      }
    }) as typeof client.on

    function Component(): null {
      useEvent('chat', () => {})
      return null
    }

    const view = await act(async () => {
      const v = render(
        <StrictMode>
          <TransportProvider client={client}>
            <Component />
          </TransportProvider>
        </StrictMode>,
      )
      await settle(30)
      return v
    })

    // One live subscription after the double mount, not two.
    expect(live).toBe(1)

    await act(async () => {
      view.unmount()
      await settle()
    })
    expect(live).toBe(0)
    client.disconnect()
  })
})
