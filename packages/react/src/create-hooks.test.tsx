/**
 * `createHooks` is a cast, so the types are only half the claim.
 *
 * The other half is that what comes back really is the working hooks: subscribing, cleaning
 * up on unmount, and reading state through the same store. A factory that returned the right
 * types and the wrong functions would satisfy every type test in this package.
 */
import { describe, expect, test } from 'bun:test'
import { act, render } from '@testing-library/react'
import { useState } from 'react'
import { createHooks } from './create-hooks.ts'
import { settle, type TestMap, wire, wireFallback } from './harness.tsx'

const api = createHooks<TestMap>()

describe('the hooks handed back actually work', () => {
  test('useEvent subscribes, receives, and unsubscribes on unmount', async () => {
    const { client, peer, wrapper } = await wire()
    const seen: string[] = []

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
      api.useEvent('chat', (m) => seen.push(m.body))
      return null
    }

    const view = render(<Component />, { wrapper })
    expect(live).toBe(1)

    await act(async () => {
      peer.emit('chat', { body: 'through the factory' })
      await settle()
    })
    expect(seen).toEqual(['through the factory'])

    await act(async () => {
      view.unmount()
      await settle()
    })
    expect(live).toBe(0)
    client.disconnect()
  })

  test('useEvent still does not resubscribe on re-render', async () => {
    const { client, wrapper } = await wire()
    let subscribes = 0
    const realOn = client.on.bind(client)
    ;(client as unknown as { on: typeof client.on }).on = ((event, handler) => {
      subscribes++
      return realOn(event, handler as never)
    }) as typeof client.on

    let bump: ((n: number) => void) | undefined
    function Component(): null {
      const [, setN] = useState(0)
      bump = setN
      api.useEvent('chat', () => {})
      return null
    }

    render(<Component />, { wrapper })
    for (let i = 1; i <= 20; i++) {
      await act(async () => {
        bump?.(i)
      })
    }
    // The Effect Event survives the factory; a naive re-export would not have.
    expect(subscribes).toBe(1)
    client.disconnect()
  })

  test('useCall round-trips through the factory', async () => {
    const { client, server, wrapper } = await wire()
    server.handle('save', async ({ text }) => ({ n: text.length }))

    let invoke: ((p: { text: string }) => Promise<{ n: number }>) | undefined
    let last = ''
    let data = -1
    function Component(): null {
      const [call, state] = api.useCall('save')
      invoke = call
      last = state.status
      if (state.status === 'success') data = state.data.n
      return null
    }

    render(<Component />, { wrapper })
    await act(async () => {
      await invoke?.({ text: 'hello' })
      await settle()
    })

    expect(last).toBe('success')
    expect(data).toBe(5)
    client.disconnect()
  })

  test('useConnection reads the same store', async () => {
    const { client, wrapper } = await wire()
    let status = ''
    function Component(): null {
      status = api.useConnection().status
      return null
    }
    render(<Component />, { wrapper })
    expect(status).toBe('connected')
    client.disconnect()
  })

  test('two maps in one process do not collide, which registration cannot do', async () => {
    // The point of the factory. Both are bound to the same contract here because the harness
    // has one, but they are independent objects with independent types, and neither reads a
    // global slot.
    const a = createHooks<TestMap>()
    const b = createHooks<TestMap>()
    expect(a).not.toBe(b)
    expect(typeof a.useEvent).toBe('function')
    expect(typeof b.useStream).toBe('function')
  })
})

describe('createHooks({ fallback: false })', () => {
  const native = createHooks<TestMap>({ fallback: false })

  test('useClient() is the client, with call on it', async () => {
    const { server, wrapper } = await wire()
    server.handle('save', async ({ text }) => ({ n: text.length }))
    let answer: { n: number } | undefined
    function Component(): null {
      const client = native.useClient()
      const same = native.useNative()
      if (answer === undefined) {
        void client.call('save', { text: 'abc' }).then((r) => {
          answer = r
        })
      }
      expect(same).toBe(client)
      return null
    }
    render(<Component />, { wrapper })
    await act(async () => {
      await settle(30)
    })
    expect(answer).toEqual({ n: 3 })
  })

  test('a fallback client mounted under it throws on first use, rather than lying', async () => {
    const { wrapper } = await wireFallback()
    function Component(): null {
      native.useClient()
      return null
    }
    let message = ''
    try {
      render(<Component />, { wrapper })
    } catch (e) {
      message = (e as Error).message
    }
    expect(message).toContain('fallback: false')
    expect(message).toContain('withFallback')
  })
})
