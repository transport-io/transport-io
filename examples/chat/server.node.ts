/**
 * The chat server. Runs under Node because it loads the QUIC transport.
 *
 * Two servers, deliberately: a plain HTTP one on 8080 serving the page, and the
 * WebTransport one on 4433 carrying the session. `http://localhost` is a trustworthy
 * origin, so the page gets a secure context without a certificate of its own - only the
 * WebTransport endpoint needs one.
 */

import { readFileSync } from 'node:fs'
import { createServer as createHttpServer } from 'node:http'
import { dirname, extname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createServer } from 'transport-io'
import { listenHttp3 } from 'transport-io/node-transport'
import { contract } from './contract.ts'

const here = dirname(fileURLToPath(import.meta.url))
const certDir = join(here, '.cert')
// Overridable, because 8080 is the most contended port on any developer's machine and the
// e2e config offers the same override. Both halves have to read it or the override is a
// knob that moves what Playwright waits for without moving what this binds - which is
// exactly what it did until a fresh-clone run caught it.
const WT_PORT = Number(process.env.E2E_WT_PORT ?? 4433)
const WEB_PORT = Number(process.env.E2E_PORT ?? 8080)
const ROOM = 'lobby'

let cert: string
let privKey: string
let hash: number[]
try {
  cert = readFileSync(join(certDir, 'cert.pem'), 'utf8')
  privKey = readFileSync(join(certDir, 'key.pem'), 'utf8')
  hash = (JSON.parse(readFileSync(join(certDir, 'hash.json'), 'utf8')) as { sha256: number[] })
    .sha256
} catch {
  console.error('No certificate found. Run `bun run cert` first.')
  process.exit(1)
}

const names = new Map<string, string>()

const server = createServer({ contract })

// Callable: the client asks for a name and gets an answer back on the same stream.
server.handle('setName', async ({ name }) => {
  const trimmed = name.trim().slice(0, 24)
  if (trimmed.length === 0) return { accepted: false, name: '' }
  return { accepted: true, name: trimmed }
})

// Streaming: one word at a time, on the same kind of stream a call uses. `break` on the
// client resets it, which fires `ctx.signal` here, which ends the loop below.
server.handle('say', async function* ({ text }) {
  for (const word of text.split(/\s+/).filter(Boolean)) {
    await new Promise((r) => setTimeout(r, 80))
    yield word
  }
})

server.onSession((peer) => {
  void peer.join(ROOM)
  names.set(peer.id, `guest-${peer.origin.toString(16).slice(-4)}`)
  console.log(`+ ${peer.id} joined (${names.size} online)`)

  peer.on('chat', (msg) => {
    // Reliable lane: everyone gets it, including the sender, so their own message appears
    // in the same order everyone else sees it.
    void server.to(ROOM).emit('chat', { ...msg, at: Date.now() })
  })

  peer.on('cursor', (pos) => {
    // Unreliable lane: excluded from the sender, because you already know where your own
    // pointer is, and a dropped one is simply the next frame's problem.
    void server.to(ROOM).except(peer.id).emit('cursor', pos)
  })
})

const listener = await listenHttp3({
  port: WT_PORT,
  host: '127.0.0.1',
  cert,
  privKey,
  path: '/',
})
console.log(`webtransport  https://127.0.0.1:${WT_PORT}/`)

// `listen(listener)` owns the accept loop. Drive `accept()` yourself only when you need
// something the loop does not do, such as inspecting a connection before accepting it.
await server.listen(listener, {
  onAcceptError: (e) => console.error('session refused:', (e as Error).message),
})

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
}

createHttpServer((req, res) => {
  if (req.url === '/cert-hash') {
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ sha256: hash, port: WT_PORT }))
    return
  }
  const rel = req.url === '/' || req.url === undefined ? '/index.html' : req.url
  const file = join(here, 'web', rel.replace(/\.\./g, ''))
  try {
    const body = readFileSync(file)
    res.writeHead(200, { 'content-type': MIME[extname(file)] ?? 'application/octet-stream' })
    res.end(body)
  } catch {
    res.writeHead(404).end('not found')
  }
}).listen(WEB_PORT, () => {
  console.log(`page          http://localhost:${WEB_PORT}/`)
  console.log('')
  console.log('Open it in Chrome or Firefox. Safari cannot talk to a quiche-backed server.')
})
