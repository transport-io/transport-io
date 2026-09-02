---
title: Getting started
description: From install to two clients exchanging a message on each lane.
sidebar:
  order: 0
---

## Install

```bash
npm install transport-io
```

The server also needs the native QUIC transport, installed separately:

```bash
npm install @fails-components/webtransport-transport-http3-quiche
```

It is not a dependency of anything, only a dynamic import, so no package manager will pull
it in for you. Browsers need nothing extra.

Two things about that native package affect CI. Its prebuilt binaries come from GitHub
Releases rather than npm. The Linux prebuild needs glibc 2.38, which no default Node `-slim`
image has, so use a `trixie` variant or Ubuntu 24.04.

You need **Node 22 or newer** and **TypeScript 5.0 or newer**.

## See it work first

One command, no project, no certificate, no configuration:

```bash
npx transport-io dev --demo
```

Open the printed URL in two tabs and type. Messages cross on the reliable lane and the
cursors follow on the unreliable one. Chrome or Firefox: Safari cannot talk to a
quiche-backed server.

## The contract

One file, and it is the only place that says what is reliable.

```ts
// contract.ts
import { defineContract, type MapOf, reliable, type$, unreliable } from 'transport-io'

export const contract = defineContract({
  chat: reliable<{ from: string; body: string }>(),
  cursor: unreliable<{ x: number; y: number }>(),
})

export interface AppMap extends MapOf<typeof contract> {}
```

Write both lines. `AppMap` is what you pass to a client or a server, once at each end, the way
you would pass a router type to a typed client.

Without the second line, every hover shows the whole contract with your validator's internals
in it.

### Types, or a schema

`reliable<T>()` describes the payload with a type. Nothing validates it at runtime, and it
costs nothing at runtime either. A peer that sends the wrong shape is caught by whatever the
handler does with it, which may be nothing.

Pass a Standard Schema instead, and inbound payloads are validated on arrival:

```ts standalone
// contract.ts, with runtime validation
import { defineContract, type MapOf, reliable, unreliable } from 'transport-io'
import { z } from 'zod'

export const contract = defineContract({
  chat: reliable(z.object({ from: z.string(), body: z.string().max(2000) })),
  cursor: unreliable(z.object({ x: z.number(), y: z.number() })),
})

export interface AppMap extends MapOf<typeof contract> {}
```

The payload types are inferred either way, so the rest of your application is identical.

| | `type$` / `reliable<T>()` | a schema |
|---|---|---|
| inbound validation | none | every message, on arrival |
| runtime cost | zero | one check per message |
| bad payload from a peer | reaches your handler | rejected with `WT_VALIDATION_FAILED` |
| dependency | none | your validator |

Use a schema wherever a peer you do not control can reach, which for a server is every
client. Use types where both ends are yours and the traffic is high, such as cursor
positions at pointer rate.

Any [Standard Schema](https://standardschema.dev) validator works: zod, valibot, arktype.
The library depends on none of them.

## The server

```ts
import { createServer } from 'transport-io'
import { listenHttp3 } from 'transport-io/node-transport'

// The PEM *text*, not a path to it. See "The certificate" below.
declare const cert: string
declare const privKey: string

const server = createServer<AppMap>({ contract })

server.onSession((peer) => {
  void peer.join('lobby')
  peer.on('chat', (msg) => void server.to('lobby').emit('chat', msg))
  peer.on('cursor', (pos) => void server.to('lobby').except(peer.id).emit('cursor', pos))
})

const listener = await listenHttp3({ port: 8080, host: '127.0.0.1', cert, privKey, path: '/' })
await server.listen(listener)
```

Rooms are server-authoritative. A client cannot join by sending a frame, so `peer.join` is
on the server side and there is no client equivalent.

## The client

```ts
import { browserClient } from 'transport-io/browser-transport'

// SHA-256 over the certificate's DER bytes. Not over `cert.pem`, which is base64 with
// header lines: hashing the file gives you 32 bytes that look right and never connect.
//   openssl x509 -in cert.pem -outform der | openssl dgst -sha256 -binary
declare const certificateHash: Uint8Array
declare function render(from: string, body: string): void
declare function moveDot(x: number, y: number): void

// In production, omit `certificateHash` entirely. The connection is then validated against
// the platform's own CA store like any other HTTPS origin, which is what you want with a
// real certificate. Pinning is a local-development affordance, not how this library works.
const production = await browserClient<AppMap>({ contract, url: 'https://example.com:443/' })

// In development, against a self-signed certificate, pin it by hash.
const client = await browserClient<AppMap>({
  contract,
  url: 'https://127.0.0.1:8080/',
  certificateHash,
})
void production

client.on('chat', ({ from, body }) => render(from, body))
client.on('cursor', ({ x, y }) => moveDot(x, y))

client.emit('chat', { from: 'me', body: 'hello' })   // arrives
client.emit('cursor', { x: 12, y: 40 })              // may not
```

`browserClient` constructs and connects. It resolves to a connected client, so there is no
second `connect()` call and no arrow wrapping the transport.

**Pass `<AppMap>`.** It is not inferred from `contract`. Leave it off and you get the sentinel
telling you to register a map or pass one.

Open two browser windows and both receive the chat message. Move the pointer in one and the
dot moves in the other, with some frames missing.

## The certificate

WebTransport will not accept an arbitrary self-signed certificate. It accepts one pinned by
hash, and the hash has to reach the browser somehow. `transport-io dev` does all of it:

```bash
npx transport-io dev ./server.ts
```

It mints the certificate, computes the hash, serves it at a fixed endpoint, and passes the
certificate to your server by environment. Two lines connect the two halves. On the server:

```ts
import type { Server } from 'transport-io'
import { listenDev } from 'transport-io/node-transport'

export async function serveInDev(server: Server<AppMap>): Promise<void> {
  await server.listen(await listenDev())
}
```

And in the browser, `connectDev` fetches the hash the command published:

```ts
import type { Client } from 'transport-io'
import { devClient } from 'transport-io/dev-transport'

export function connect(): Promise<Client<AppMap>> {
  return devClient<AppMap>({ contract })
}
```

`connectDev` refuses to run anywhere that is not loopback, both for the page origin and for
the WebTransport URL it is given. That is a property of the function rather than a
convention, so a bundle that reaches production cannot connect through it.

### What `dev` does not do

**It does not bundle your browser code.** Keep running your own `vite dev` or
`bun build --watch` and point the command at the output:

```bash
npx transport-io dev ./server.ts --static ./web/dist
```

### Doing it by hand

For production, or to understand what the command is doing:

```bash
openssl ecparam -name prime256v1 -genkey -noout -out key.pem
openssl req -new -x509 -key key.pem -out cert.pem -days 14 \
  -subj '/CN=localhost' -addext 'subjectAltName=DNS:localhost,IP:127.0.0.1'
```

ECDSA P-256 and a maximum of 14 days are constraints imposed by
`serverCertificateHashes`. Pass the SHA-256 of the certificate's DER bytes to
`connectBrowser` as `certificateHash`.

## Registering the map (optional)

An application that builds clients or servers in many files can register the map once instead,
and then drop the type argument everywhere:

```ts standalone
import { Client, defineContract, type MapOf, reliable } from 'transport-io'

export const contract = defineContract({ chat: reliable<{ body: string }>() })
export interface AppMap extends MapOf<typeof contract> {}

declare module 'transport-io' {
  interface Register {
    map: AppMap
  }
}

// `Client` and `Server` now default to AppMap, with no type argument anywhere.
declare const client: Client
client.emit('chat', { body: 'hi' })
```

**The tradeoff.** It is a global augmentation, so there is one slot per process: two contracts
in the same process conflict, and the type a file sees depends on which module was loaded
rather than on what that file imported. It changes no hover; it removes the type argument and
nothing else.

`@transport-io/react` does not need it either: `createHooks<AppMap>()` binds the hooks to a
map the same way everything else takes one.

## Where next

[The two lanes](/guides/lanes/) covers choosing between them.
[`call()` and `stream()`](/guides/call-and-stream/) covers request shapes.
[React](/guides/react/) is the binding, if that is what you are building in.
[Limitations](/limitations/) is worth reading before you commit to this.
