/**
 * The health check, run by a systemd timer. Its exit status restarts the service and its
 * JSON result is what server.node.ts reads before serving a page.
 *
 *   page   GET /agents.html is 200 and is the demo page
 *   cert   the certificate TCP 443 presents is the one on disk, with more than seven days left
 *   udp    something is bound on UDP 443
 *   wt     a WebTransport handshake and one call, pinned to the on-disk certificate
 */
import { execFileSync } from 'node:child_process'
import { createHash, X509Certificate } from 'node:crypto'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { connect as tlsConnect } from 'node:tls'
import { http3Client } from 'transport-io/node-transport'
import { type ChatMap, contract } from '../contract.ts'

const HOST = process.env.DEMO_HOST ?? ''
const CERT_DIR = process.env.DEMO_CERT_DIR ?? '/var/lib/transport-io-demo/cert'
const STATE = process.env.DEMO_HEALTH_STATE ?? '/var/lib/transport-io-demo/health.json'
const MIN_DAYS_LEFT = 7

interface Step {
  readonly name: string
  readonly ok: boolean
  readonly detail: string
}
const steps: Step[] = []
const step = (name: string, ok: boolean, detail: string): void => {
  steps.push({ name, ok, detail })
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}: ${detail}`)
}

if (HOST === '') {
  console.error('DEMO_HOST is not set')
  process.exit(2)
}

// ---- page
try {
  const res = await fetch(`https://${HOST}/agents.html`, { redirect: 'manual' })
  const body = await res.text()
  const isDemo = body.includes('id="a-out"')
  step(
    'page',
    res.status === 200 && isDemo,
    `status ${res.status}, demo page ${isDemo ? 'yes' : 'no'}`,
  )
} catch (e) {
  step('page', false, (e as Error).message)
}

// ---- cert
const leaf = new X509Certificate(readFileSync(join(CERT_DIR, 'cert.pem'), 'utf8'))
const onDisk = leaf.fingerprint256
const daysLeft = (Date.parse(leaf.validTo) - Date.now()) / 86_400_000
try {
  const presented = await new Promise<string>((resolve, reject) => {
    const s = tlsConnect({ host: HOST, port: 443, servername: HOST }, () => {
      const fp = s.getPeerCertificate().fingerprint256
      s.end()
      resolve(fp)
    })
    s.on('error', reject)
  })
  const same = presented === onDisk
  step(
    'cert',
    same && daysLeft > MIN_DAYS_LEFT,
    `${same ? 'presented certificate matches disk' : `presented ${presented}, disk ${onDisk}`}, ${daysLeft.toFixed(1)} days left`,
  )
} catch (e) {
  step('cert', false, (e as Error).message)
}

// ---- udp
try {
  const out = execFileSync('ss', ['-lun'], { encoding: 'utf8' })
  const bound = /:443\s/.test(out)
  step('udp', bound, bound ? 'UDP 443 is bound' : 'nothing bound on UDP 443')
} catch (e) {
  step('udp', false, `could not run ss: ${(e as Error).message}`)
}

// ---- wt
try {
  const der = leaf.raw
  const hash = createHash('sha256').update(der).digest()
  const client = await http3Client<ChatMap>({
    contract,
    url: `https://${HOST}:443/`,
    certificateHash: new Uint8Array(hash),
    handshakeDeadlineMs: 5_000,
  })
  const named = await client.call(
    'setName',
    { name: 'health' },
    { signal: AbortSignal.timeout(5_000) },
  )
  client.disconnect()
  step(
    'wt',
    named.accepted,
    `handshake and one call completed, pinned to the on-disk certificate`,
  )
} catch (e) {
  const msg = (e as Error).message
  step(
    'wt',
    false,
    `${msg}. If this names the certificate's validity and the page works in a browser, the ` +
      'demo is fine and this probe is not: the Node client pins the certificate, and the ' +
      'binding may refuse to pin a ninety-day one. Fix: reissue with ' +
      '`certbot certonly --standalone --key-type ecdsa --required-profile shortlived -d HOST` ' +
      '(a 160-hour certificate, so the restart comes every three days). deploy/README.md, "Known unknowns".',
  )
}

const ok = steps.every((s) => s.ok)
mkdirSync(dirname(STATE), { recursive: true })
writeFileSync(
  STATE,
  `${JSON.stringify({ ok, at: new Date().toISOString(), steps }, null, 2)}\n`,
)
process.exit(ok ? 0 : 1)
