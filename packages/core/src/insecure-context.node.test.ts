/**
 * A page that is not a secure context has `crypto` with `getRandomValues` and nothing else:
 * no `crypto.subtle`, and no `WebTransport`. This is that runtime, made by replacing the
 * global, and a `withFallback` client on it. See D156.
 *
 * The event ids are the first four bytes of SHA-256 of the name (PROTOCOL.md §5.4), and the
 * handshake compares them with the server's, which computes its own with `crypto.subtle`. So
 * the ids must not differ by a byte between the two ways of hashing, and the vectors below
 * are pinned from outside both: `printf '%s' <name> | shasum -a 256`, first eight hex digits.
 */
import assert from 'node:assert/strict'
import { afterEach, test } from 'node:test'
import { withFallback } from './client.ts'
import {
  buildEventTable,
  defineContract,
  eventIdOf,
  type MapOf,
  reliable,
  unreliable,
} from './contract.ts'
import { createServer } from './server.ts'
import { connectBrowser } from './transport/browser.ts'
import { listenWebSocket } from './transport/websocket.node.ts'
import { connectWebSocket } from './transport/websocket.ts'

const VECTORS: readonly (readonly [string, number])[] = [
  ['chat', 0x31e06f7d],
  ['cursor', 0x46a4eebd],
  // Two bytes of UTF-8, then four, then a name longer than one 64-byte SHA-256 block.
  ['café', 0x850f7dc4],
  ['🚀 launch', 0x774e9f9c],
  ['a-much-longer-event-name-that-crosses-one-sha256-block-of-sixty-four-bytes', 0x6a31cff6],
]

const secure = globalThis.crypto

/** `crypto` as a page that is not a secure context has it. */
function insecure(): void {
  Object.defineProperty(globalThis, 'crypto', {
    configurable: true,
    value: { getRandomValues: secure.getRandomValues.bind(secure) },
  })
}

afterEach(() => {
  Object.defineProperty(globalThis, 'crypto', { configurable: true, value: secure })
})

test('the vectors, through crypto.subtle', async () => {
  for (const [name, id] of VECTORS) assert.equal(await eventIdOf(name), id, name)
})

test('the vectors, with no crypto.subtle', async () => {
  insecure()
  assert.equal(globalThis.crypto.subtle, undefined)
  for (const [name, id] of VECTORS) assert.equal(await eventIdOf(name), id, name)
})

const contract = defineContract({
  chat: reliable<{ body: string }>(),
  cursor: unreliable<{ x: number; y: number }>({ fallback: 'newest' }),
})
interface AppMap extends MapOf<typeof contract> {}

test('the table a page with no crypto.subtle builds is the one the server builds', async () => {
  const server = await buildEventTable(contract)
  insecure()
  const page = await buildEventTable(contract)
  assert.deepEqual(page.wire(), server.wire())
})

test('a withFallback client with no crypto.subtle and no WebTransport connects over the WebSocket', async () => {
  // The server is built first, on a runtime that has `crypto.subtle`, as a server does.
  const listener = await listenWebSocket({ port: 0 })
  const server = createServer<AppMap>({ contract })
  await server.listen()
  server.withFallback(listener)
  server.onSession((peer) => {
    peer.on('chat', (p) => void peer.emit('chat', { body: `echo: ${p.body}` }))
  })

  insecure()
  assert.equal(typeof (globalThis as { WebTransport?: unknown }).WebTransport, 'undefined')
  const called: string[] = []
  const client = withFallback<AppMap>({
    contract,
    connect: () => {
      called.push('native')
      return connectBrowser({ url: `https://127.0.0.1:${listener.port}/` })
    },
    fallback: () => {
      called.push('fallback')
      return connectWebSocket({ url: `ws://127.0.0.1:${listener.port}/` })
    },
  })
  const echoed = new Promise<{ body: string }>((resolve) => client.on('chat', resolve))

  try {
    await client.connect()
    const s = client.getSnapshot()
    assert.deepEqual(called, ['native', 'fallback'])
    assert.equal(s.status, 'connected')
    assert.equal(s.transport, 'websocket')
    // A runtime with no WebTransport is what `unsupported` already says.
    assert.equal(s.fallbackReason, 'unsupported')
    assert.equal(s.lastError, null)

    client.emit('chat', { body: 'from a page with no crypto.subtle' })
    assert.deepEqual(await echoed, { body: 'echo: from a page with no crypto.subtle' })
  } finally {
    client.disconnect()
    listener.stop()
  }
})
