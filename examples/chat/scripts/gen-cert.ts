/**
 * Mints the short-lived certificate the browser needs.
 *
 * WebTransport will not accept an arbitrary self-signed certificate. It accepts one
 * pinned by hash, and only under three constraints that are easy to get wrong:
 * ECDSA P-256, SHA-256, and a total validity of at most 14 days.
 */
import { execFileSync } from 'node:child_process'
import { createHash, X509Certificate } from 'node:crypto'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const out = join(here, '..', '.cert')
mkdirSync(out, { recursive: true })

const keyPath = join(out, 'key.pem')
const certPath = join(out, 'cert.pem')

execFileSync('openssl', [
  'ecparam',
  '-name',
  'prime256v1',
  '-genkey',
  '-noout',
  '-out',
  keyPath,
])
execFileSync('openssl', [
  'req',
  '-new',
  '-x509',
  '-key',
  keyPath,
  '-out',
  certPath,
  '-days',
  '14',
  '-subj',
  '/CN=localhost',
  '-addext',
  'subjectAltName=DNS:localhost,IP:127.0.0.1',
])

const cert = readFileSync(certPath, 'utf8')
const hash = createHash('sha256').update(new X509Certificate(cert).raw).digest()
writeFileSync(join(out, 'hash.json'), JSON.stringify({ sha256: [...hash] }))

const notAfter = new X509Certificate(cert).validTo
console.log(`certificate written to ${out}`)
console.log(`  expires ${notAfter} - regenerate with \`bun run cert\` when it does`)
console.log(`  sha-256 ${hash.toString('hex')}`)
