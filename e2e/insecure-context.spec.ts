import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { createServer as createHttpServer, type Server } from 'node:http'
import { tmpdir } from 'node:os'
import { extname, join, resolve } from 'node:path'
import { expect, test } from '@playwright/test'
import { build } from 'esbuild'
import { buildEventTable } from '../packages/core/dist/contract.js'
import {
  createServer,
  defineContract,
  type MapOf,
  reliable,
  unreliable,
} from '../packages/core/dist/index.js'
import { listenWebSocket } from '../packages/core/dist/transport/websocket.node.js'

/**
 * A page that is not a secure context, in a real browser: `http` on a hostname that is not
 * loopback. `localhost` and `127.0.0.1` are secure contexts, so the hostname is mapped to
 * loopback by the browser's own resolver instead, and the page really has no `crypto.subtle`
 * and no `WebTransport`. That is the case the WebSocket fallback exists for (D156).
 *
 * The page is bundled here, split the way an application's bundler splits it, because the
 * SHA-256 that replaces `crypto.subtle` is a chunk loaded on demand, and this is what proves
 * a real page loads it. The server is Node, with `crypto.subtle`, so a handshake that
 * completes is two ways of hashing that agree on every id.
 */

const HOST = 'insecure.transport-io.test'

test.use({
  launchOptions: {
    ...(process.env.E2E_BROWSER === undefined
      ? {}
      : { executablePath: process.env.E2E_BROWSER }),
    args: [`--host-resolver-rules=MAP ${HOST} 127.0.0.1`],
  },
})

const contract = defineContract({
  chat: reliable<{ body: string }>(),
  cursor: unreliable<{ n: number }>({ fallback: 'newest' }),
})
interface AppMap extends MapOf<typeof contract> {}

const PAGE = `
import { defineContract, reliable, unreliable, withFallback } from './packages/core/dist/index.js'
import { buildEventTable } from './packages/core/dist/contract.js'
import { connectBrowser } from './packages/core/dist/transport/browser.js'
import { connectWebSocket } from './packages/core/dist/transport/websocket.js'

const contract = defineContract({ chat: reliable(), cursor: unreliable({ fallback: 'newest' }) })

window.run = async (host, port) => {
  const page = {
    secure: globalThis.isSecureContext,
    subtle: typeof globalThis.crypto.subtle,
    webTransport: typeof globalThis.WebTransport,
  }
  const wire = (await buildEventTable(contract)).wire()
  const called = []
  const client = withFallback({
    contract,
    connect: () => {
      called.push('native')
      return connectBrowser({ url: 'https://' + host + ':' + port + '/' })
    },
    fallback: () => {
      called.push('fallback')
      return connectWebSocket({ url: 'ws://' + host + ':' + port + '/' })
    },
  })
  const got = []
  client.on('chat', (p) => got.push(p))
  const outcome = await client.connect().then(
    () => 'resolved',
    (e) => 'rejected ' + e.code + ': ' + e.message,
  )
  const s = client.getSnapshot()
  if (s.status === 'connected') {
    client.emit('chat', { body: 'from an insecure page' })
    await new Promise((r) => setTimeout(r, 600))
  }
  client.disconnect()
  return {
    page,
    wire,
    called,
    outcome,
    status: s.status,
    transport: s.transport,
    reason: s.fallbackReason,
    lastError: s.lastError === null ? null : s.lastError.code + ': ' + s.lastError.message,
    got,
  }
}
`

/** The page, bundled with splitting into a directory of its own, served over plain `http`. */
async function servePage(): Promise<{ server: Server; port: number; dir: string }> {
  const dir = await mkdtemp(join(tmpdir(), 'transport-io-insecure-'))
  await build({
    stdin: { contents: PAGE, resolveDir: resolve(import.meta.dirname, '..'), loader: 'js' },
    bundle: true,
    splitting: true,
    format: 'esm',
    platform: 'browser',
    target: 'es2022',
    entryNames: 'page',
    outdir: dir,
    logLevel: 'silent',
  })
  await writeFile(
    join(dir, 'index.html'),
    '<!doctype html><title>insecure</title><script type="module" src="/page.js"></script>',
  )
  const server = createHttpServer((req, res) => {
    const name = (req.url ?? '/') === '/' ? 'index.html' : (req.url ?? '').slice(1)
    readFile(join(dir, name)).then(
      (body) => {
        res.setHeader('content-type', extname(name) === '.js' ? 'text/javascript' : 'text/html')
        res.end(body)
      },
      () => {
        res.statusCode = 404
        res.end()
      },
    )
  })
  await new Promise<void>((ok) => server.listen(0, '127.0.0.1', ok))
  const address = server.address()
  const port = address !== null && typeof address === 'object' ? address.port : 0
  return { server, port, dir }
}

test('a page that is not a secure context connects through the WebSocket fallback', async ({
  page,
}) => {
  const listener = await listenWebSocket({ port: 0 })
  const server = createServer<AppMap>({ contract })
  await server.listen()
  server.withFallback(listener)
  server.onSession((peer) => {
    peer.on('chat', (p) => void peer.emit('chat', { body: `echo: ${p.body}` }))
  })
  const served = await servePage()
  const chunks: string[] = []
  page.on('request', (r) => {
    const path = new URL(r.url()).pathname
    if (path.endsWith('.js')) chunks.push(path)
  })

  try {
    await page.goto(`http://${HOST}:${served.port}/`)
    await page.waitForFunction(() => 'run' in window)
    const result = await page.evaluate(
      ([host, port]) =>
        (window as unknown as { run: (h: string, p: number) => unknown }).run(host, port),
      [HOST, listener.port] as const,
    )
    const r = result as {
      page: unknown
      wire: unknown
      called: string[]
      outcome: string
      status: string
      transport: string | null
      reason: string | null
      lastError: string | null
      got: unknown[]
    }

    // The premise: this page is what the consumer had.
    expect(r.page).toEqual({ secure: false, subtle: 'undefined', webTransport: 'undefined' })
    // The SHA-256 chunk was requested, so the ids below came from it and not from the entry.
    expect(chunks.some((c) => /\/sha256-[^/]*\.js$/.test(c))).toBe(true)
    // Byte for byte the ids Node computes with `crypto.subtle`.
    expect(r.wire).toEqual((await buildEventTable(contract)).wire())

    expect(r.outcome).toBe('resolved')
    expect(r.called).toEqual(['native', 'fallback'])
    expect(r.status).toBe('connected')
    expect(r.transport).toBe('websocket')
    expect(r.reason).toBe('unsupported')
    expect(r.lastError).toBeNull()
    expect(r.got).toContainEqual({ body: 'echo: from an insecure page' })
  } finally {
    listener.stop()
    served.server.close()
    await rm(served.dir, { recursive: true, force: true })
  }
})
