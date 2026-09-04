/**
 * `useStream`, and the two properties that are invisible until they are wrong: `elements`
 * keeping its identity between renders, and an unmount actually reaching the responder.
 */
import { describe, expect, test } from 'bun:test'
import { act, render } from '@testing-library/react'
import { useState } from 'react'
import { settle, wire } from './harness.tsx'
import { useStream } from './use-stream.ts'

describe('elements identity', () => {
  test('the same array between renders when nothing was appended', async () => {
    const { client, server, wrapper } = await wire()
    server.handle('ask', async function* () {
      yield 'a'
      yield 'b'
    })

    const arrays: (readonly string[])[] = []
    let start: ((p: { prompt: string }) => void) | undefined
    let bump: ((n: number) => void) | undefined

    function Component(): null {
      const [, setN] = useState(0)
      bump = setN
      const [begin, state] = useStream('ask')
      start = begin
      if (state.status !== 'idle') arrays.push(state.elements)
      return null
    }

    render(<Component />, { wrapper })
    await act(async () => {
      start?.({ prompt: 'x' })
      await settle(40)
    })

    const settled = arrays[arrays.length - 1]
    // Re-render twice with no new element. A fresh array here breaks every consumer
    // memoising on it, which is the defect class `getSnapshot` stability exists to prevent.
    await act(async () => {
      bump?.(1)
    })
    await act(async () => {
      bump?.(2)
    })

    expect(arrays[arrays.length - 1]).toBe(settled as readonly string[])
    expect(settled).toEqual(['a', 'b'])
    client.disconnect()
  })

  test('a new array when an element is appended, not the same one mutated', async () => {
    const { client, server, wrapper } = await wire()
    // A gate rather than a delay: React batches every update inside one `act()`, so timing
    // alone cannot separate two appends. The test releases one element per act block.
    let release: (() => void) | undefined
    const gate = (): Promise<void> =>
      new Promise<void>((resolve) => {
        release = resolve
      })

    server.handle('ask', async function* () {
      yield 'a'
      await gate()
      yield 'b'
    })

    const arrays: (readonly string[])[] = []
    let start: ((p: { prompt: string }) => void) | undefined
    function Component(): null {
      const [begin, state] = useStream('ask')
      start = begin
      if (state.status !== 'idle') arrays.push(state.elements)
      return null
    }

    render(<Component />, { wrapper })
    await act(async () => {
      start?.({ prompt: 'x' })
      await settle(30)
    })
    const afterFirst = arrays[arrays.length - 1]
    expect(afterFirst).toEqual(['a'])

    await act(async () => {
      release?.()
      await settle(30)
    })
    const afterSecond = arrays[arrays.length - 1]

    expect(afterSecond).toEqual(['a', 'b'])
    // A different array, so anything memoising on it recomputes. Pushing into the existing
    // one would keep this reference and silently strand every consumer.
    expect(afterSecond).not.toBe(afterFirst as readonly string[])
    client.disconnect()
  })
})

describe('unmounting mid-generation', () => {
  test('cancels, and the responder`s finally runs', async () => {
    const { client, server, wrapper } = await wire()
    let finallyRan = false
    server.handle('ask', async function* () {
      try {
        for (let i = 0; i < 1000; i++) {
          yield `token-${i}`
          await new Promise((r) => setTimeout(r, 5))
        }
      } finally {
        finallyRan = true
      }
    })

    let start: ((p: { prompt: string }) => void) | undefined
    function Component(): null {
      const [begin] = useStream('ask')
      start = begin
      return null
    }

    const view = render(<Component />, { wrapper })
    await act(async () => {
      start?.({ prompt: 'x' })
      await settle(20)
    })
    await act(async () => {
      view.unmount()
      await settle(40)
    })

    // The cancel resets the QUIC stream, the responder sees STOP_SENDING, its signal fires
    // and the generator's finally runs. A leak here is a generator producing into nothing.
    expect(finallyRan).toBe(true)
    client.disconnect()
  })

  test('stop() reports done with what arrived, and the responder`s finally runs', async () => {
    const { client, server, wrapper } = await wire()
    let finallyRan = false
    server.handle('ask', async function* () {
      try {
        for (let i = 0; i < 1000; i++) {
          yield `token-${i}`
          await new Promise((r) => setTimeout(r, 5))
        }
      } finally {
        finallyRan = true
      }
    })

    let start: ((p: { prompt: string }) => void) | undefined
    let stop: (() => void) | undefined
    let last: { status: string; elements?: readonly string[] } = { status: 'idle' }
    function Component(): null {
      const [begin, state, end] = useStream('ask')
      start = begin
      stop = end
      last = state
      return null
    }

    render(<Component />, { wrapper })
    await act(async () => {
      start?.({ prompt: 'x' })
      await settle(20)
    })
    expect(last.status).toBe('streaming')
    const arrived = last.elements?.length ?? 0
    expect(arrived).toBeGreaterThan(0)

    await act(async () => {
      stop?.()
      await settle(40)
    })

    // A stop button is the whole reason the third element exists, and a state that stays
    // `streaming` after it keeps the button on screen and the consumer waiting.
    expect(last.status).toBe('done')
    expect(last.elements?.length).toBe(arrived)
    expect(finallyRan).toBe(true)
    client.disconnect()
  })

  test('a completed stream reports done, not error', async () => {
    const { client, server, wrapper } = await wire()
    server.handle('ask', async function* () {
      yield 'only'
    })

    let start: ((p: { prompt: string }) => void) | undefined
    let last = ''
    function Component(): null {
      const [begin, state] = useStream('ask')
      start = begin
      last = state.status
      return null
    }

    render(<Component />, { wrapper })
    await act(async () => {
      start?.({ prompt: 'x' })
      await settle(40)
    })

    expect(last).toBe('done')
    client.disconnect()
  })
})
