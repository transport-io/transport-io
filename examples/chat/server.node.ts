/** The local server: the page on 8080 over plain HTTP, WebTransport on 4433. Node only. */

import { readFileSync } from 'node:fs'
import { createServer as createHttpServer } from 'node:http'
import { dirname, extname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createServer } from 'transport-io'
import { listenHttp3 } from 'transport-io/node-transport'
import { attach } from './app.ts'
import { type ChatMap, contract } from './contract.ts'

const here = dirname(fileURLToPath(import.meta.url))
const certDir = join(here, '.cert')
const WT_PORT = Number(process.env.E2E_WT_PORT ?? 4433)
const WEB_PORT = Number(process.env.E2E_PORT ?? 8080)

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

const server = createServer<ChatMap>({ contract })
attach(server)

const listener = await listenHttp3({
  port: WT_PORT,
  host: '127.0.0.1',
  cert,
  privKey,
  path: '/',
})
console.log(`webtransport  https://127.0.0.1:${WT_PORT}/`)

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
