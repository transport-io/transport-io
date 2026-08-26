/**
 * Minimal reproduction of the moq server-close deadlock (D71).
 *
 * No transport-io involved. `NapiServer.close()` never returns if an `accept()` is
 * outstanding, so a moq server cannot be shut down gracefully — a server that accepts
 * connections always has an accept pending.
 *
 *   node packages/core/src/bench/moq-close-deadlock.node.ts          # returns, exits
 *   node packages/core/src/bench/moq-close-deadlock.node.ts accept   # HANGS FOREVER
 *
 * The second form deadlocks in a synchronous native call, so no JavaScript watchdog can
 * rescue it. Kill it from another shell. Run this when checking whether upstream has
 * fixed the deadlock.
 */
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

interface RawServer {
  accept: () => Promise<unknown>
  close: () => void
}
const napi = createRequire(import.meta.url)('@moq/web-transport-darwin-arm64') as {
  NapiServer: { bind: (addr: string, cert: Buffer, key: Buffer) => RawServer }
}

const d = mkdtempSync(join(tmpdir(), 'moq-deadlock-'))
execFileSync('openssl', [
  'ecparam',
  '-name',
  'prime256v1',
  '-genkey',
  '-noout',
  '-out',
  join(d, 'k.pem'),
])
execFileSync('openssl', [
  'req',
  '-new',
  '-x509',
  '-key',
  join(d, 'k.pem'),
  '-out',
  join(d, 'c.pem'),
  '-days',
  '14',
  '-subj',
  '/CN=localhost',
  '-addext',
  'subjectAltName=DNS:localhost,IP:127.0.0.1',
])

const withAccept = process.argv[2] === 'accept'
const server = napi.NapiServer.bind(
  '127.0.0.1:49555',
  readFileSync(join(d, 'c.pem')),
  readFileSync(join(d, 'k.pem')),
)
console.log('bound')
if (withAccept) {
  void server.accept().catch(() => undefined)
  await new Promise((r) => setTimeout(r, 300))
}
console.log(`calling close()${withAccept ? ' with an accept pending' : ''}...`)
server.close()
console.log('close() RETURNED')
process.exit(0)
