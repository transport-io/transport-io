---
title: Certificates
description: What transport-io dev does for you locally, and what you do yourself to deploy.
---

WebTransport does not accept an arbitrary self-signed certificate. A browser accepts one
from a CA it trusts, or a short-lived one pinned by hash. Local development uses the second
and deploying uses the first, and the two differ by one option at each end.

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

**A page served by something else** needs the hash too. `devClient` fetches it from the
page's own origin at `/.well-known/transport-io-dev`, so a Vite dev server proxies that one
path to the command's port. `examples/react` does exactly this.

## Deploying

A certificate from a CA, and no hash anywhere. The listener takes the PEM text, not a path:

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
platform's CA store:

```ts file=production.ts title="client.ts, deployed"
import { browserClient } from 'transport-io/browser-transport'
import { type AppMap, contract } from './contract.ts'

export const client = await browserClient<AppMap>({ contract, url: 'https://example.com:443/' })
```

**The listener does not reload a renewed certificate.** Restart the process after each
renewal. `examples/chat/deploy` is a runbook that does this with certbot hooks.

**The server needs raw UDP ingress**, on the port the listener binds. A reverse proxy, a CDN
or a managed load balancer in front of it terminates TLS and drops UDP, and nothing connects.
[The fallback](/guides/fallback/) is what carries emits through such a proxy.

## Pinning by hand

A self-signed certificate without the command, for a setup the command does not cover:

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
