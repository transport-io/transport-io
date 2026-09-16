/**
 * `useCall`, and specifically the two things a union buys: impossible states cannot be
 * written, and unmounting does not leave a call running into nothing.
 */
import { describe, expect, test } from 'bun:test'
import { act, render } from '@testing-library/react'
import { settle, wire, wireFallback } from './harness.tsx'
import { useCall } from './use-call.ts'

describe('the state machine', () => {
  test('idle, then pending, then success with data narrowed by status', async () => {
    const { client, server, wrapper } = await wire()
    // Slow enough that `pending` is a render of its own. With an instant handler React
    // batches the pending and success updates together and no consumer ever sees pending,
    // which is correct behaviour rather than a defect.
    server.handle('save', async ({ text }) => {
      await new Promise((r) => setTimeout(r, 25))
      return { n: text.length }
    })

    const states: string[] = []
    let invoke: ((p: { text: string }) => Promise<{ n: number }>) | undefined

    function Component(): null {
      const [call, state] = useCall('save')
      invoke = call
      states.push(state.status)
      // `data` exists only on the success branch. This does not compile otherwise.
      if (state.status === 'success') states.push(`n=${state.data.n}`)
      return null
    }

    render(<Component />, { wrapper })
    expect(states[0]).toBe('idle')

    // Start it without awaiting, so the pending render happens on its own.
    await act(async () => {
      void invoke?.({ text: 'hello' })
      await settle(5)
    })
    expect(states).toContain('pending')

    await act(async () => {
      await settle(60)
    })
    expect(states).toContain('n=5')
    client.disconnect()
  })

  test('a handler that throws lands in the error branch', async () => {
    const { client, server, wrapper } = await wire()
    server.handle('save', async () => {
      throw new Error('nope')
    })

    let invoke: ((p: { text: string }) => Promise<{ n: number }>) | undefined
    let last = ''
    function Component(): null {
      const [call, state] = useCall('save')
      invoke = call
      last = state.status
      return null
    }

    render(<Component />, { wrapper })
    await act(async () => {
      // The promise rejects as well; the state is what this test is about.
      await invoke?.({ text: 'x' }).catch(() => undefined)
      await settle()
    })

    expect(last).toBe('error')
    client.disconnect()
  })
})

describe('unmounting', () => {
  test('aborts an in-flight call by default, and the handler sees the abort', async () => {
    const { client, server, wrapper } = await wire()
    let aborted = false
    server.handle('save', async (_p, ctx) => {
      await new Promise<void>((resolve) => {
        ctx.signal.addEventListener('abort', () => {
          aborted = true
          resolve()
        })
        setTimeout(resolve, 2000)
      })
      return { n: 0 }
    })

    let invoke: ((p: { text: string }) => Promise<{ n: number }>) | undefined
    function Component(): null {
      const [call] = useCall('save')
      invoke = call
      return null
    }

    const view = render(<Component />, { wrapper })
    await act(async () => {
      void invoke?.({ text: 'x' })
      await settle(5)
    })
    await act(async () => {
      view.unmount()
      await settle()
    })

    // The abort is a QUIC stream reset, which is what reaches the responder's signal.
    expect(aborted).toBe(true)
    client.disconnect()
  })

  test('abortOnUnmount:false leaves the call running, for a server side effect', async () => {
    const { client, server, wrapper } = await wire()
    let aborted = false
    let completed = false
    server.handle('save', async (_p, ctx) => {
      ctx.signal.addEventListener('abort', () => {
        aborted = true
      })
      await new Promise((r) => setTimeout(r, 30))
      completed = true
      return { n: 1 }
    })

    let invoke: ((p: { text: string }) => Promise<{ n: number }>) | undefined
    function Component(): null {
      const [call] = useCall('save', { abortOnUnmount: false })
      invoke = call
      return null
    }

    const view = render(<Component />, { wrapper })
    await act(async () => {
      void invoke?.({ text: 'x' })
      await settle(5)
    })
    await act(async () => {
      view.unmount()
      await settle(60)
    })

    expect(aborted).toBe(false)
    expect(completed).toBe(true)
    client.disconnect()
  })
})

describe('on a fallback session', () => {
  test('the state is unavailable before anyone asks, and invoking asks nothing', async () => {
    const { client, server, wrapper } = await wireFallback()
    let asked = 0
    server.handle('save', async ({ text }) => {
      asked++
      return { n: text.length }
    })

    const seen: string[] = []
    let invoke: ((p: { text: string }) => Promise<{ n: number }>) | undefined
    function Component(): null {
      const [call, state] = useCall('save')
      invoke = call
      seen.push(state.status)
      return null
    }

    render(<Component />, { wrapper })
    expect(seen[0]).toBe('unavailable')

    await act(async () => {
      await expect(invoke?.({ text: 'hello' })).rejects.toMatchObject({
        code: 'WT_LANE_UNAVAILABLE',
      })
      await settle(10)
    })
    expect(asked).toBe(0)
    expect(seen.every((s) => s === 'unavailable')).toBe(true)
    client.disconnect()
  })
})

describe('the function resolves to the answer', () => {
  test('resolves with the data the state also shows', async () => {
    const { server, wrapper } = await wire()
    server.handle('save', async ({ text }) => ({ n: text.length }))
    let invoke: ((p: { text: string }) => Promise<{ n: number }>) | undefined
    let last: string = 'idle'
    function Component(): null {
      const [call, state] = useCall('save')
      invoke = call
      last = state.status
      return null
    }
    render(<Component />, { wrapper })
    await act(async () => {
      await settle(10)
    })
    let answer: { n: number } | undefined
    await act(async () => {
      answer = await invoke?.({ text: 'seven!!' })
      await settle(10)
    })
    expect(answer).toEqual({ n: 7 })
    expect(last).toBe('success')
  })

  test('rejects with the TransportError the state shows, and an ignored rejection is observed', async () => {
    const { server, wrapper } = await wire()
    server.handle('save', async () => {
      throw new Error('no')
    })
    let invoke: ((p: { text: string }) => Promise<{ n: number }>) | undefined
    let last: string = 'idle'
    function Component(): null {
      const [call, state] = useCall('save')
      invoke = call
      last = state.status
      return null
    }
    render(<Component />, { wrapper })
    await act(async () => {
      await settle(10)
    })
    await act(async () => {
      await expect(invoke?.({ text: 'x' })).rejects.toMatchObject({ code: 'WT_HANDLER_ERROR' })
      await settle(10)
    })
    expect(last).toBe('error')
    // Fire and forget: the failure lands in the state and nowhere else.
    await act(async () => {
      void invoke?.({ text: 'y' })
      await settle(20)
    })
    expect(last).toBe('error')
  })

  test('a superseded call rejects with WT_ABORTED while the newer one resolves', async () => {
    const { server, wrapper } = await wire()
    server.handle('save', async ({ text }) => {
      await settle(text === 'slow' ? 30 : 1)
      return { n: text.length }
    })
    let invoke: ((p: { text: string }) => Promise<{ n: number }>) | undefined
    function Component(): null {
      const [call] = useCall('save')
      invoke = call
      return null
    }
    render(<Component />, { wrapper })
    await act(async () => {
      await settle(10)
    })
    let outcome: string = ''
    await act(async () => {
      const slow = invoke?.({ text: 'slow' }).catch((e: { code: string }) => e.code)
      const fast = invoke?.({ text: 'fast' })
      outcome = `${await slow} ${(await fast)?.n}`
      await settle(40)
    })
    expect(outcome).toBe('WT_ABORTED 4')
  })
})
