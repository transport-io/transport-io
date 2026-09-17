/**
 * The React mount: a panel while the component is mounted, under StrictMode too, nothing
 * unless the build says development, and no panel code in a production bundle.
 *
 * `TransportDevtools` reads `process.env.NODE_ENV` once, as the module loads, so each case
 * sets it and then imports the module fresh.
 */
import { afterEach, describe, expect, test } from 'bun:test'
import { cleanup, render } from '@testing-library/react'
import { build } from 'esbuild'
import { StrictMode } from 'react'
import type { ClientState, FrameObserver } from 'transport-io'
import type { ObservableClient } from './store.ts'

const state: ClientState = Object.freeze({
  status: 'connected',
  sessionId: 's-1',
  rooms: [],
  lastError: null,
  refused: null,
  transport: 'webtransport',
  fallbackReason: null,
})

function fake(): { client: ObservableClient; observers: () => number } {
  const observers = new Set<FrameObserver>()
  return {
    client: {
      observe: (o) => {
        observers.add(o)
        return () => void observers.delete(o)
      },
      subscribe: () => () => undefined,
      getSnapshot: () => state,
      stats: () => undefined,
    },
    observers: () => observers.size,
  }
}

async function load(env: string): Promise<typeof import('./react.tsx')> {
  const before = process.env.NODE_ENV
  process.env.NODE_ENV = env
  try {
    return (await import(`./react.tsx?${env}`)) as typeof import('./react.tsx')
  } finally {
    if (before === undefined) delete process.env.NODE_ENV
    else process.env.NODE_ENV = before
  }
}

const panels = (): number => document.querySelectorAll('[data-transport-io-devtools]').length

afterEach(cleanup)

describe('in development', () => {
  test('mounted with the component, gone with it, and it renders nothing itself', async () => {
    const { TransportDevtools } = await load('development')
    const c = fake()
    const view = render(<TransportDevtools client={c.client} />)
    expect(view.container.childElementCount).toBe(0)
    expect(panels()).toBe(1)
    expect(c.observers()).toBe(1)

    view.unmount()
    expect(panels()).toBe(0)
    expect(c.observers()).toBe(0)
  })

  test('StrictMode mounts twice, and one panel and one subscription are left', async () => {
    const { TransportDevtools } = await load('development')
    const c = fake()
    const view = render(
      <StrictMode>
        <TransportDevtools client={c.client} open />
      </StrictMode>,
    )
    expect(panels()).toBe(1)
    expect(c.observers()).toBe(1)
    view.unmount()
    expect(c.observers()).toBe(0)
  })
})

describe('anywhere else', () => {
  for (const env of ['production', 'test', '']) {
    test(`NODE_ENV "${env}" renders nothing and observes nothing`, async () => {
      const { TransportDevtools } = await load(env)
      const c = fake()
      render(<TransportDevtools client={c.client} open />)
      expect(panels()).toBe(0)
      expect(c.observers()).toBe(0)
    })
  }

  test('a production bundle contains none of the panel', async () => {
    const bundle = async (env: string): Promise<string> => {
      const result = await build({
        entryPoints: [new URL('./react.tsx', import.meta.url).pathname],
        bundle: true,
        minify: true,
        format: 'esm',
        platform: 'browser',
        external: ['react', 'react/jsx-runtime', 'transport-io'],
        define: { 'process.env.NODE_ENV': JSON.stringify(env) },
        write: false,
        logLevel: 'silent',
      })
      return result.outputFiles[0]?.text ?? ''
    }
    const development = await bundle('development')
    const production = await bundle('production')

    // A string only the panel has, and one only the store has.
    expect(development).toContain('Copy rows')
    expect(development).toContain('overflow-dropped')
    expect(production).not.toContain('Copy rows')
    expect(production).not.toContain('overflow-dropped')
    // What is left is the component that returns null: an absolute bound, not a ratio.
    expect(production.length).toBeLessThan(300)
  })
})
