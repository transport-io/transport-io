---
title: Deploying
description: What a platform has to give a transport-io server, what to set, and what will surprise you, from a first deployment.
---

Only the WebTransport server needs UDP. Your pages, your API, your database and your sign-in
stay wherever they already are, behind whatever proxy or CDN is in front of them. The one new
thing is a process a browser reaches over UDP with nothing in between, and an HTTPS endpoint
that tells the page how to reach it.

This page comes from one deployment, to [Fly](https://fly.io): a Node server with a
WebTransport listener and an HTTP server in one process. What is Fly's is said to be Fly's,
and [a different platform](#on-a-different-platform) has the same list to satisfy.

The contract on this page:

```ts file=contract.ts
import { defineContract, type MapOf, reliable } from 'transport-io'

export const contract = defineContract({
  chat: reliable<{ from: string; body: string }>(),
})

export interface AppMap extends MapOf<typeof contract> {}

export interface User {
  name: string
}
```

## An address of its own

A proxy terminates TLS and forwards TCP, so nothing proxied carries a session, and a platform
whose shared ingress is a proxy has to give a UDP listener an address of its own. On Fly that
is a dedicated IPv4: UDP is not routed over a shared IPv4, and not over IPv6 at all.

**Do not dial the platform's hostname.** It has an AAAA record as well, so a browser that
resolves it can land on IPv6, where nothing answers UDP. The page dials the literal IPv4,
which it learns at runtime from an endpoint on its own origin, or a hostname of your own
with only an A record.

That choice decides your certificate. A certificate from a CA does not cover a bare address,
so a page that dials one pins a self-signed certificate, in production, with everything that
follows from it: [Certificates](/guides/certificates/#which-certificate-a-deployed-server-is-on)
has both paths and what each costs.

## The port and the bind

**The UDP port is never rewritten.** The port your process listens on is the public port,
and it is the one your users' firewalls see. Listening on one port and exposing another,
the habit from HTTP, does not work here.

**`listenHttp3` binds `127.0.0.1` unless you pass `host`**, which is right on your machine
and receives nothing on a platform.

**The bind address is the platform's, and may not be `0.0.0.0`.** Fly delivers UDP to a
socket bound to the name `fly-global-services`. A wildcard bind receives the packets and
answers from the wrong source address, and the client never sees a reply:

```ts file=server.node.ts
import { lookup } from 'node:dns/promises'
import { createServer } from 'transport-io'
import { listenHttp3 } from 'transport-io/node-transport'
import { type AppMap, contract, type User } from './contract.ts'

declare const cert: string
declare const privKey: string
declare function userFor(token: string | null): Promise<User | null>

const onFly = process.env.FLY_APP_NAME !== undefined
const host = onFly ? (await lookup('fly-global-services', { family: 4 })).address : '0.0.0.0'

const server = createServer<AppMap, User>({ contract })
await server.listen(
  await listenHttp3({
    port: 4433,
    host,
    cert,
    privKey,
    path: '/',
    authorize: ({ query }) => userFor(query.get('token')),
  }),
)
```

## One process, kept running

**Two machines is a silent split, not an error.** Rooms, membership and anything else your
server holds are per process, the adapter that ships is in memory, and there is no Redis
adapter. Two machines are two disjoint sets of rooms, which one a client gets depends on how
the platform routes its packets, and nothing detects it. A token any machine can verify
still works, which is what makes it look healthy. Fly starts two machines for a new app
unless told otherwise, so tell it: `fly deploy --ha=false`.

**Do not let the platform stop it when idle.** What is in memory goes with the machine, and
Fly's proxy wakes a stopped machine on TCP traffic, which a WebTransport client never sends.

**A clean exit has to restart.** A pinned certificate is rotated by leaving and starting
again, and under a restart-on-failure policy, Fly's default, a process that exits with 0
stays down. Set the policy to always, and expect it to restart a crash loop as well.

Every restart drops every session. A client with `reconnect` comes back on its own, as
[a new session](/guides/reconnect/).

## Health checks

**There is no UDP health check.** Fly's checks are TCP and HTTP, so a UDP process is only as
observable as a TCP listener attached to it. An application that is purely WebTransport
opens an HTTP port for that purpose alone, or runs unchecked. One process serving both, as
here, is checked through its HTTP side.

Expect one failed check on each boot, and set the grace period generously. This server was
listening 3 seconds after it started, a 10 second grace period still logged a failure on
every restart, and the deployment raised it to 20.

## The image

**The native transport needs glibc 2.38**, so Debian trixie or Ubuntu 24.04:
`node:22-trixie-slim`, not `node:22-slim`, which is bookworm. The wrong one builds, and
fails when the process starts, with a load error.

**Bun blocks install scripts**, and the transport's prebuilt binary arrives in one. Until
`trustedDependencies` lists `@fails-components/webtransport-transport-http3-quiche`, the
install prints `Blocked 1 postinstall` and the binary is missing.

A server that mints its own certificate needs `openssl` in the image. The slim image here
had to have it installed.

The smallest shared machine with 256 MB was enough: with the server running, 111 MB of 212
MB were free.

On Fly, all of the above is this much of `fly.toml`:

```toml
[http_service]
  internal_port = 8080
  force_https = true
  auto_stop_machines = 'off'
  auto_start_machines = false
  min_machines_running = 1

  [[http_service.checks]]
    method = 'GET'
    path = '/api/health'
    grace_period = '20s'

[[services]]
  internal_port = 4433
  protocol = 'udp'

  [[services.ports]]
    port = 4433

[[restart]]
  policy = 'always'
```

## Signing in

A WebTransport request carries no cookie, so the token your page's origin issues has to be
handed to the page and put in the URL:

1. The page signs in to its own origin, however it already does, and the origin sets its
   session cookie.
2. An endpoint on that origin reads the cookie and returns a short-lived token as JSON.
3. The page asks the same origin where the WebTransport server is, and for the certificate
   hash if it pins.
4. The page dials that URL with the token in the query.
5. `authorize` verifies the token and returns what it learned, which is `peer.data`. A bad
   token is `refuse('bad-token')`, and that peer never receives the event table.

All of it happens inside `connect`, which runs on every attempt, so a reconnect gets a fresh
token, and after a rotation a fresh hash:

```ts file=client.ts
import { Client } from 'transport-io'
import { connectBrowser } from 'transport-io/browser-transport'
import { type AppMap, contract } from './contract.ts'

async function connect() {
  const session = await fetch('/api/session')
  const { token } = (await session.json()) as { token: string }
  const transport = await fetch('/api/transport')
  const { url, sha256 } = (await transport.json()) as { url: string; sha256: string }

  const target = new URL(url)
  target.searchParams.set('token', token)
  const bytes = sha256.match(/../g) ?? []
  return connectBrowser({
    url: target.href,
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

[Authenticating a peer](/guides/authorize/) has the server side, and why the token has to be
short-lived.

## What `authorize` covers, and what nothing does

**transport-io checks no origin and authenticates nothing on its own.** There is no
equivalent of a WebSocket server's origin check. A listener with no `authorize` accepts
every peer, from any page and from anything that is not a page.

`authorize` is the only gate. It runs once for every session, each reconnect included,
before the peer receives anything, and what it returns is `peer.data`.

What it does not do:

- **It does not look at the origin unless you do.** A browser puts the page's origin in
  `headers.origin` on a WebTransport request. Compare it there if only your own pages may
  connect. That stops another site from using a visitor's browser. It does not stop a
  program, which sends whatever origin it likes, so it goes beside the token, not in place
  of it.
- **It does not run again.** A peer it accepted stays accepted until the session ends. What a
  peer may do once inside is for your handlers to decide, and
  `peer.close(CloseCode.WT_UNAUTHORIZED, reason)` ends a session whose token ran out.
- **It does not limit anybody.** Nothing in the library caps sessions per address or per
  token.

A public address is found quickly. This one had a scanner's request in its logs, with no
host name on it, the day it went up, and there is nothing to fix about that.

## What it cost

Two lines, about equal: the dedicated address, and the smallest machine running all the
time. Bandwidth rounded to nothing. The address is the part with no TCP equivalent.

## On a different platform

Fly is where this was done, not the only place it can be. A platform has to give you:

1. UDP delivered to your process, on a port you choose, with nothing terminating it on the
   way.
2. A stable public address for it, and a way to learn which address to bind.
3. A restart policy that restarts a clean exit, and no stopping when idle.
4. An image with glibc 2.38 or later.
5. A TCP port for its health check, if it checks health at all.

Beyond the platform you need one instance, not several, and an HTTPS origin anywhere, which
your page already has. Before building on a platform, check the first item:
`WT_UDP_UNREACHABLE` is what a client reports when the server is up and UDP is not reaching
it.
