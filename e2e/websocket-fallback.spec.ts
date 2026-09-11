import { createServer as createNetServer } from 'node:net'
import { expect, test } from '@playwright/test'
import {
  createServer,
  defineContract,
  type MapOf,
  reliable,
  unreliable,
} from '../packages/core/dist/index.js'
import { listenWebSocket } from '../packages/core/dist/transport/websocket.node.js'
import { DEMO_ORIGIN } from '../playwright.config.ts'

/**
 * The whole chain in a real browser: a WebTransport dial that fails because nothing listens
 * on that UDP port, the probe that finds the same port answering over TCP, the fallback that
 * engages on that evidence and nothing else, the emit lane over the socket in both
 * directions, and a declared unreliable event crossing it wrapped. The page is the demo's,
 * used only because it serves the built package as ESM; the server is this test's own.
 */

const contract = defineContract({
  chat: reliable<{ body: string }>(),
  cursor: unreliable<{ n: number }>({ fallback: 'newest' }),
})
interface AppMap extends MapOf<typeof contract> {}

test('a blocked QUIC path falls back to the WebSocket, and emits cross it both ways', async ({
  page,
}) => {
  const listener = await listenWebSocket({ port: 0 })
  const server = createServer<AppMap>({ contract })
  await server.listen()
  server.withFallback(listener)
  const peers: string[] = []
  server.onSession((peer) => {
    peers.push(peer.transport)
    void peer.join('lobby')
    peer.on('chat', (p) => void server.to('lobby').emit('chat', { body: `echo: ${p.body}` }))
    peer.on('cursor', (p) => void server.to('lobby').emit('cursor', p))
  })

  await page.goto(DEMO_ORIGIN)
  const result = await page.evaluate(
    async ({ origin, port }) => {
      const core = await import(`${origin}/_transport-io/index.js`)
      const browser = await import(`${origin}/_transport-io/transport/browser.js`)
      const ws = await import(`${origin}/_transport-io/transport/websocket.js`)
      const c = core.defineContract({
        chat: core.reliable(),
        cursor: core.unreliable({ fallback: 'newest' }),
      })
      const client = core.withFallback({
        contract: c,
        // Nothing listens on this port over UDP, and the WebSocket listener answers on it
        // over TCP: exactly the shape a firewall or a platform with no UDP ingress produces.
        connect: () =>
          browser.connectBrowser({
            url: `https://127.0.0.1:${port}/`,
            probe: `http://127.0.0.1:${port}/.well-known/transport-io`,
          }),
        fallback: () => ws.connectWebSocket({ url: `ws://127.0.0.1:${port}/` }),
      })
      const got: unknown[] = []
      client.on('chat', (p: unknown) => got.push(p))
      client.on('cursor', (p: unknown) => got.push(p))
      await client.connect()
      const snapshot = client.getSnapshot()
      client.emit('chat', { body: 'from a page' })
      client.emit('cursor', { n: 3 })
      await new Promise((resolve) => setTimeout(resolve, 600))
      const native = client.native
      client.disconnect()
      return {
        transport: snapshot.transport,
        reason: snapshot.fallbackReason,
        nativeIsNull: native === null,
        got,
      }
    },
    { origin: DEMO_ORIGIN, port: listener.port },
  )

  expect(result.transport).toBe('websocket')
  expect(result.reason).toBe('unreachable')
  expect(result.nativeIsNull).toBe(true)
  expect(result.got).toContainEqual({ body: 'echo: from a page' })
  expect(result.got).toContainEqual({ n: 3 })
  expect(peers).toEqual(['websocket'])
  listener.stop()
})

/** A port nothing listens on, over TCP or UDP: bound once to learn its number, then closed. */
function deadPort(): Promise<number> {
  return new Promise((resolve) => {
    const s = createNetServer()
    s.listen(0, '127.0.0.1', () => {
      const { port } = s.address() as { port: number }
      s.close(() => resolve(port))
    })
  })
}

/**
 * The deployment the fallback guide documents, with nothing set by hand: WebTransport on one
 * port that is dead over UDP and answers nothing over TCP, the WebSocket on another port,
 * and no `probe`. On 0.8.0 the probe at the WebTransport origin went unanswered, the error
 * stayed `WT_HANDSHAKE_FAILED`, and the fallback never engaged (D125).
 */
test('WebTransport on a dead port and the WebSocket on another falls back with no probe set', async ({
  page,
}) => {
  const listener = await listenWebSocket({ port: 0 })
  const server = createServer<AppMap>({ contract })
  await server.listen()
  server.withFallback(listener)
  const peers: string[] = []
  server.onSession((peer) => {
    peers.push(peer.transport)
    void peer.join('lobby')
    peer.on('chat', (p) => void server.to('lobby').emit('chat', { body: `echo: ${p.body}` }))
  })
  const dead = await deadPort()

  await page.goto(DEMO_ORIGIN)
  const result = await page.evaluate(
    async ({ origin, dead, port }) => {
      const core = await import(`${origin}/_transport-io/index.js`)
      const browser = await import(`${origin}/_transport-io/transport/browser.js`)
      const ws = await import(`${origin}/_transport-io/transport/websocket.js`)
      const c = core.defineContract({
        chat: core.reliable(),
        cursor: core.unreliable({ fallback: 'newest' }),
      })
      const client = core.withFallback({
        contract: c,
        connect: () => browser.connectBrowser({ url: `https://127.0.0.1:${dead}/` }),
        fallback: () => ws.connectWebSocket({ url: `ws://127.0.0.1:${port}/` }),
      })
      const got: unknown[] = []
      client.on('chat', (p: unknown) => got.push(p))
      try {
        await client.connect()
      } catch (e) {
        return { failed: (e as { code?: string }).code ?? String(e) }
      }
      const snapshot = client.getSnapshot()
      client.emit('chat', { body: 'from a page' })
      await new Promise((resolve) => setTimeout(resolve, 600))
      client.disconnect()
      return {
        failed: null,
        transport: snapshot.transport,
        reason: snapshot.fallbackReason,
        lastError: snapshot.lastError,
        got,
      }
    },
    { origin: DEMO_ORIGIN, dead, port: listener.port },
  )

  expect(result.failed).toBeNull()
  expect(result.transport).toBe('websocket')
  expect(result.reason).toBe('unreachable')
  expect(result.lastError).toBeNull()
  expect(result.got).toContainEqual({ body: 'echo: from a page' })
  expect(peers).toEqual(['websocket'])
  listener.stop()
})

test('a contract with an undeclared unreliable event is refused on the fallback, before the handshake', async ({
  page,
}) => {
  const listener = await listenWebSocket({ port: 0 })
  await page.goto(DEMO_ORIGIN)
  const result = await page.evaluate(
    async ({ origin, port }) => {
      const core = await import(`${origin}/_transport-io/index.js`)
      const ws = await import(`${origin}/_transport-io/transport/websocket.js`)
      const c = core.defineContract({ chat: core.reliable(), cursor: core.unreliable() })
      // The types refuse this in TypeScript; the page is JavaScript, which is what the
      // runtime half of the gate exists for.
      const client = core.withFallback({
        contract: c,
        connect: () => Promise.reject(new core.TransportError('WT_NO_SUPPORT', 'x', 'x')),
        fallback: () => ws.connectWebSocket({ url: `ws://127.0.0.1:${port}/` }),
      })
      try {
        await client.connect()
        return { code: 'connected' }
      } catch (e) {
        return { code: (e as { code?: string }).code ?? '' }
      }
    },
    { origin: DEMO_ORIGIN, port: listener.port },
  )
  expect(result.code).toBe('WT_RELIABILITY_REFUSED')
  listener.stop()
})
