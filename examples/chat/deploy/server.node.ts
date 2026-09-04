/**
 * The public demo server: a CA certificate, no pinned hash, three listeners in one process.
 *   TCP 80   redirects to https
 *   TCP 443  the pages and /healthz; 503 while the health check says the transport is down
 *   UDP 443  WebTransport
 * The runbook is README.md beside this file.
 */
import { readFileSync } from 'node:fs'
import { createServer as createHttpServer } from 'node:http'
import { createServer as createHttpsServer } from 'node:https'
import { dirname, extname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { CloseCode, createServer } from 'transport-io'
import { listenHttp3 } from 'transport-io/node-transport'
import { attach } from '../app.ts'
import { type ChatMap, contract } from '../contract.ts'

function env(name: string, fallback?: string) {
  const v = process.env[name] ?? fallback
  if (v === undefined) {
    console.error(`${name} is not set`)
    process.exit(1)
  }
  return v
}

const HOST = env('DEMO_HOST')
const CERT_DIR = env('DEMO_CERT_DIR', '/var/lib/transport-io-demo/cert')
const STATE = env('DEMO_HEALTH_STATE', '/var/lib/transport-io-demo/health.json')
/** Concurrent sessions. Past it a connection is closed before it is accepted. */
const MAX_SESSIONS = Number(env('DEMO_MAX_SESSIONS', '32'))
/** Concurrent `generate` streams per session, enforced in `app.ts`. */
const MAX_GENERATIONS = Number(env('DEMO_MAX_GENERATIONS', '4'))
/** How long a SIGTERM waits for live streams before the process exits regardless. */
const DRAIN_MS = Number(env('DEMO_DRAIN_MS', '15000'))
/** A health result older than this counts as a failure. */
const HEALTH_STALE_MS = 3 * 60_000

const here = dirname(fileURLToPath(import.meta.url))
const web = join(here, '..', 'web')
const cert = readFileSync(join(CERT_DIR, 'fullchain.pem'), 'utf8')
const privKey = readFileSync(join(CERT_DIR, 'privkey.pem'), 'utf8')

const server = createServer<ChatMap>({ contract })
attach(server, { maxGenerationsPerPeer: MAX_GENERATIONS })
// No listener here: the accept loop below refuses over the cap before accepting.
await server.listen()

const listener = await listenHttp3({ port: 443, host: '0.0.0.0', cert, privKey, path: '/' })
let live = 0
let draining = false

const accepting = (async () => {
  for await (const conn of listener.sessions()) {
    if (draining || live >= MAX_SESSIONS) {
      conn.close(CloseCode.WT_NO_ERROR, draining ? 'restarting' : 'demo at capacity')
      continue
    }
    live++
    void conn.closed.then(() => {
      live--
    })
    void server.accept(conn).catch((e: unknown) => {
      console.error('session refused:', (e as Error).message)
    })
  }
})()
void accepting.catch((e: unknown) => console.error('accept loop ended:', (e as Error).message))
console.log(`webtransport  https://${HOST}:443/  (udp)  cap ${MAX_SESSIONS} sessions`)
console.log(
  'note          renewal restarts this process and drops every session; see deploy/README.md',
)

// ------------------------------------------------------------------ the pages, over https

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
}

interface Health {
  ok: boolean
  at: string
  steps: { name: string; ok: boolean; detail: string }[]
}

/** The last health run, or the reason there is not a usable one. */
function health() {
  let raw: string
  try {
    raw = readFileSync(STATE, 'utf8')
  } catch {
    return { ok: false, reason: 'the health check has not written a result yet', body: '{}' }
  }
  let h: Health
  try {
    h = JSON.parse(raw) as Health
  } catch {
    return { ok: false, reason: 'the health result is not JSON', body: raw }
  }
  const age = Date.now() - Date.parse(h.at)
  if (!(age < HEALTH_STALE_MS)) {
    return {
      ok: false,
      reason: `the last health result is ${Math.round(age / 1000)}s old`,
      body: raw,
    }
  }
  if (!h.ok) {
    const failed = h.steps.filter((s) => !s.ok).map((s) => `${s.name}: ${s.detail}`)
    return { ok: false, reason: failed.join('; '), body: raw }
  }
  return { ok: true, reason: '', body: raw }
}

const https = createHttpsServer({ cert, key: privKey }, (req, res) => {
  const path = (req.url ?? '/').split('?')[0] ?? '/'
  if (path === '/healthz') {
    const h = health()
    res.writeHead(h.ok ? 200 : 503, { 'content-type': 'application/json; charset=utf-8' })
    res.end(h.body)
    return
  }
  const rel = path === '/' ? '/index.html' : path
  if (rel.endsWith('.html')) {
    const h = health()
    if (!h.ok) {
      res.writeHead(503, { 'content-type': 'text/plain; charset=utf-8', 'retry-after': '60' })
      res.end(`transport-io demo is down: ${h.reason}\n`)
      return
    }
  }
  const file = join(web, rel.replace(/\.\./g, ''))
  try {
    const body = readFileSync(file)
    res.writeHead(200, {
      'content-type': MIME[extname(file)] ?? 'application/octet-stream',
      'cache-control': 'no-store',
    })
    res.end(body)
  } catch {
    res.writeHead(404).end('not found')
  }
})
https.listen(443, '0.0.0.0', () => console.log(`page          https://${HOST}/`))

createHttpServer((req, res) => {
  res.writeHead(301, { location: `https://${HOST}${req.url ?? '/'}` })
  res.end()
}).listen(80, '0.0.0.0')

// ------------------------------------------------------------------ drain on SIGTERM

// Stop accepting, wait up to DRAIN_MS for live sessions, then exit. TimeoutStopSec in the
// unit is longer, so this is what decides.
process.on('SIGTERM', () => {
  draining = true
  console.log(`SIGTERM: draining ${live} session(s) for up to ${DRAIN_MS}ms`)
  https.close()
  const deadline = Date.now() + DRAIN_MS
  const tick = setInterval(() => {
    if (live === 0 || Date.now() > deadline) {
      clearInterval(tick)
      listener.stop()
      process.exit(0)
    }
  }, 200)
})
