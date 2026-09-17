---
title: Certificates
description: Which certificate a deployed server ends up on and what each one costs, and what transport-io dev does for you locally.
---

WebTransport does not accept an arbitrary self-signed certificate. A browser accepts one
from a CA it trusts, or a short-lived one pinned by hash. Local development pins. A deployed
server is on whichever of the two its address allows, and that is often pinning as well, so
[settle which](#which-certificate-a-deployed-server-is-on) before you plan anything else.

The contract on this page:

```ts file=contract.ts
import { defineContract, type MapOf, reliable } from 'transport-io'

export const contract = defineContract({
  chat: reliable<{ from: string; body: string }>(),
})

export interface AppMap extends MapOf<typeof contract> {}
```

## In development

One command mints the certificate, computes its hash, serves the hash at a fixed path, and
passes the certificate to your server by environment:

```bash
npx transport-io dev ./server.node.ts
```

On the server, `listenDev()` reads what the command passed in:

```ts file=server.node.ts
import { createServer } from 'transport-io'
import { listenDev } from 'transport-io/node-transport'
import { type AppMap, contract } from './contract.ts'

const server = createServer<AppMap>({ contract })

await server.listen(await listenDev())
```

In the browser, `devClient` fetches the hash the command published and connects with it:

```ts file=client.ts
import { devClient } from 'transport-io/dev-transport'
import { type AppMap, contract } from './contract.ts'

export const client = await devClient<AppMap>({ contract })
```

The certificate lasts 14 days. A second start reuses it, so the hash an open tab pinned
stays valid. When it lapses, the next start mints a new one and an open tab fails with
`WT_CERT_EXPIRED` until it is reloaded.

`connectDev` refuses any origin that is not loopback, so a bundle that reaches production
cannot connect through it. The error is `WT_DEV_ONLY`.

**The command does not bundle your browser code.** Keep running your own `vite dev` or
`bun build --watch` and point the command at the output:

```bash
npx transport-io dev ./server.node.ts --static ./web/dist
```

Without `--static` it serves the first of `public`, `web/dist`, `web` and `dist` that exists.

**Your server runs as a child of the command.** SIGTERM, SIGINT and SIGHUP sent to the
command are passed to the server, and the command exits once the server has. On Ctrl-C the
terminal signals both processes, so a SIGINT handler in your server runs twice. SIGKILL
cannot be passed on. A server left behind by one still holds its port, and the next run
reports `WT_PORT_IN_USE`.

**A page served by something else** needs the hash too. `devClient` fetches it from the
page's own origin at `/.well-known/transport-io-dev`, so a Vite dev server proxies that one
path to the command's port. `examples/react` does exactly this. `fetchDevManifest()` is that
fetch on its own, with the same loopback checks, for tooling that wants the hash or the URL
without connecting.

## Which certificate a deployed server is on

It depends on what the page dials, and on how often you can let every session drop.

A platform whose shared ingress is a proxy has to give a UDP listener an address of its own.
On [Fly](https://fly.io), where this was first deployed, that is a dedicated IPv4, while the
platform's hostname also has an AAAA record. A browser that resolves the name can land on
IPv6, where nothing answers, so the page dials the literal IPv4, and a certificate issued for
a hostname does not cover a bare address. Any platform whose UDP answers on one address
family while its hostname resolves in both puts you in the same place, with three ways out:

| | Pinned | From a CA, for the address | From a CA, for a hostname |
| --- | --- | --- | --- |
| The page dials | an address, or any hostname | the address | a hostname of your own that resolves only to where UDP answers |
| The certificate | self-signed, ECDSA P-256, valid at most 14 days | free from [Let's Encrypt](https://letsencrypt.org/docs/profiles/), in its `shortlived` profile only, valid 160 hours | any CA's, for as long as it issues them |
| You run | `openssl` at startup, and an HTTPS endpoint that serves the hash | an ACME client, storage that keeps the certificate across restarts, and TCP port 80 or 443 on the same address, which is where the CA validates it | an ACME client, and that storage |
| Every session drops | every 12 days | every 6 days | at each renewal |

**The listener does not reload a certificate**, so all three rotate by restarting the
process, and every restart drops every session. That is what the last row counts: a pinned
certificate minted for 13 days with the process leaving on the twelfth, and a 160-hour
certificate renewed before its seventh day. A page with `reconnect` comes back on its own,
as [a new session](/guides/reconnect/).

**Two things about the middle column are unmeasured.** Nobody here has watched a browser
accept a CA's certificate for an address over WebTransport. And on Fly, nobody has checked
that the platform's proxy passes the CA's validation request on port 80 through to the
application.

**A pinned server needs an HTTPS origin as well.** The page has to learn the hash before it
can connect, and it can only trust a hash it fetched over HTTPS from an origin the browser
already trusts. So a UDP listener and an HTTPS endpoint are one requirement, not two. They
can be one process, or the HTTPS side can be wherever your page is already served.
[Deploying](/guides/deploy/) has the rest of what a platform has to provide.

### Pinned, in production

The server mints a certificate each time it starts, computes the hash over the DER, serves
it, and leaves before the certificate lapses:

```ts file=pinned-server.node.ts title="server.node.ts, pinned"
import { execFileSync } from 'node:child_process'
import { createHash, X509Certificate } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { createServer as createHttpServer } from 'node:http'
import { createServer } from 'transport-io'
import { listenHttp3 } from 'transport-io/node-transport'
import { type AppMap, contract } from './contract.ts'

// the address the page dials, and the one your platform delivers UDP to
const ADDRESS = '203.0.113.7'
const HOST = process.env.LISTEN_HOST ?? '0.0.0.0'
const DAY = 24 * 60 * 60 * 1000

execFileSync('openssl', ['ecparam', '-name', 'prime256v1', '-genkey', '-noout', '-out', 'key.pem'])
execFileSync('openssl', [
  ...['req', '-new', '-x509', '-key', 'key.pem', '-out', 'cert.pem', '-days', '13'],
  ...['-subj', `/CN=${ADDRESS}`, '-addext', `subjectAltName=IP:${ADDRESS}`],
])
const cert = readFileSync('cert.pem', 'utf8')
const privKey = readFileSync('key.pem', 'utf8')
const sha256 = createHash('sha256').update(new X509Certificate(cert).raw).digest('hex')

const server = createServer<AppMap>({ contract })
await server.listen(await listenHttp3({ port: 4433, host: HOST, cert, privKey, path: '/' }))

// the page asks for this before every connect
createHttpServer((req, res) => {
  if (req.url === '/api/transport') {
    res.setHeader('content-type', 'application/json')
    res.end(JSON.stringify({ url: `https://${ADDRESS}:4433/`, sha256 }))
    return
  }
  res.statusCode = 404
  res.end()
}).listen(8080)

// leave before the certificate lapses, and let the supervisor start a fresh process
setTimeout(() => process.exit(0), 12 * DAY)
```

The page fetches the URL and the hash inside `connect`, which runs on every attempt, so a
page that was open across a rotation reconnects with the new hash:

```ts file=pinned-client.ts title="client.ts, pinned"
import { Client } from 'transport-io'
import { connectBrowser } from 'transport-io/browser-transport'
import { type AppMap, contract } from './contract.ts'

async function connect() {
  const res = await fetch('/api/transport')
  const { url, sha256 } = (await res.json()) as { url: string; sha256: string }
  const bytes = sha256.match(/../g) ?? []
  return connectBrowser({
    url,
    certificateHash: Uint8Array.from(bytes, (byte) => Number.parseInt(byte, 16)),
    probe: `${location.origin}/.well-known/transport-io`,
  })
}

export const client = new Client<AppMap>({
  contract,
  connect,
  reconnect: { minMs: 500, maxMs: 30_000 },
})
```

**The supervisor has to restart a clean exit.** Many restart only a failure by default, and
a process that exits with 0 then stays down with an expired certificate behind it.

**Say where the probe goes.** After a failed handshake the client asks whether the server
answers over HTTPS, to tell a blocked UDP path from a dead server, and by default it asks the
origin it dialled. Nothing speaks HTTPS on a bare address and a UDP port, so point `probe` at
an HTTPS endpoint the same process serves. Any status is an answer. Leave it alone if the
HTTPS side is a different host, since that host being up says nothing about this one.

### From a CA

For a hostname or for an address, the listener takes the PEM text, not a path:

```ts file=deploy.node.ts title="server.node.ts, deployed"
import { readFile } from 'node:fs/promises'
import { createServer } from 'transport-io'
import { listenHttp3 } from 'transport-io/node-transport'
import { type AppMap, contract } from './contract.ts'

const server = createServer<AppMap>({ contract })

const cert = await readFile('/etc/letsencrypt/live/example.com/fullchain.pem', 'utf8')
const privKey = await readFile('/etc/letsencrypt/live/example.com/privkey.pem', 'utf8')

await server.listen(await listenHttp3({ port: 443, host: '0.0.0.0', cert, privKey, path: '/' }))
```

The browser connects to the origin like any other HTTPS origin, validated against the
platform's CA store, and no hash appears anywhere:

```ts file=production.ts title="client.ts, deployed"
import { browserClient } from 'transport-io/browser-transport'
import { type AppMap, contract } from './contract.ts'

export const client = await browserClient<AppMap>({ contract, url: 'https://example.com:443/' })
```

`examples/chat/deploy` is a runbook for this path on a machine of your own, with certbot
hooks that restart the process after each renewal. On a platform that replaces the machine
on every deploy, the certificate has to live on a volume, or each start asks the CA again.

For an address, Certbot 5.4 or later asks for it by profile, and the page dials
`https://203.0.113.7:4433/` with no hash:

```bash
certbot certonly --preferred-profile shortlived --webroot \
  --webroot-path /var/www/html --ip-address 203.0.113.7
```

An address is validated over `http-01` or `tls-alpn-01` only, never over DNS.

## Pinning by hand

The two commands behind a pinned certificate, for a setup the dev command does not cover:

```bash
openssl ecparam -name prime256v1 -genkey -noout -out key.pem
openssl req -new -x509 -key key.pem -out cert.pem -days 14 \
  -subj '/CN=localhost' -addext 'subjectAltName=DNS:localhost,IP:127.0.0.1'
```

ECDSA P-256 and at most 14 days of validity are what a browser accepts for a pinned
certificate. The hash is SHA-256 over the certificate's DER bytes, not over `cert.pem`:

```bash
openssl x509 -in cert.pem -outform der | openssl dgst -sha256 -binary
```

Pass those 32 bytes to `connectBrowser` as `certificateHash`:

```ts file=pinned.ts title="client.ts, pinned by hand"
import { Client } from 'transport-io'
import { connectBrowser } from 'transport-io/browser-transport'
import { type AppMap, contract } from './contract.ts'

export function pinned(certificateHash: Uint8Array): Client<AppMap> {
  return new Client<AppMap>({
    contract,
    connect: () => connectBrowser({ url: 'https://127.0.0.1:4433/', certificateHash }),
  })
}
```

A wrong hash, an expired certificate and a server that is not running all fail with the
same `WT_HANDSHAKE_FAILED`. [Troubleshooting](/troubleshooting/#wt_handshake_failed) has the
order to rule them out in.
