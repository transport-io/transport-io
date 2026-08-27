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

The server also needs the native QUIC transport, which is a separate, deliberate install:

```bash
npm install @fails-components/webtransport-transport-http3-quiche
```

It is not a dependency of anything, only a dynamic import, so no package manager will pull
it in for you. Browsers need nothing extra. Two things about that native package will
surprise your CI: its prebuilt binaries come from GitHub Releases rather than npm, and the
Linux prebuild needs glibc 2.38, which no default Node `-slim` image has. Use a `trixie`
variant or Ubuntu 24.04.

You need **Node 22 or newer** and **TypeScript 5.0 or newer**.

## The contract

One file, and it is the only place that says what is reliable.

```ts
// contract.ts
import { defineContract, type MapOf, type$ } from 'transport-io'

export const contract = defineContract({
  chat:   { lane: 'reliable',   payload: type$<{ from: string; body: string }>() },
  cursor: { lane: 'unreliable', payload: type$<{ x: number; y: number }>() },
})

export interface AppMap extends MapOf<typeof contract> {}
```

**Write both lines.** The second is what keeps hover readable: with it, hovering `emit`
shows 107 characters; without it, 353, including your validator's internal types. Those
numbers are for this contract and are re-measured on every CI run.

## The server

```ts
import { createServer } from 'transport-io'
import { listenHttp3 } from 'transport-io/node-transport'
import { contract, type AppMap } from './contract.ts'

const server = createServer<AppMap>({ contract })
await server.listen()

server.onSession((peer) => {
  void peer.join('lobby')
  peer.on('chat', (msg) => void server.to('lobby').emit('chat', msg))
  peer.on('cursor', (pos) => void server.to('lobby').except(peer.id).emit('cursor', pos))
})

const listener = await listenHttp3({ port: 8080, host: '127.0.0.1', cert, privKey, path: '/' })
for await (const conn of listener.sessions()) void server.accept(conn)
```

Rooms are server-authoritative. A client cannot join by sending a frame, which is why
`peer.join` is on the server side and there is no client equivalent.

## The client

```ts
import { Client } from 'transport-io'
import { connectBrowser } from 'transport-io/browser-transport'
import { contract, type AppMap } from './contract.ts'

const client = new Client<AppMap>({
  contract,
  connect: () => connectBrowser({ url: 'https://127.0.0.1:8080/', certificateHash }),
})
await client.connect()

client.on('chat', ({ from, body }) => render(from, body))
client.on('cursor', ({ x, y }) => moveDot(x, y))

client.emit('chat', { from: 'me', body: 'hello' })   // arrives
client.emit('cursor', { x: 12, y: 40 })              // may not
```

Open two browser windows and both receive the chat message. Move the pointer in one and the
dot moves in the other, with some frames missing, which is the unreliable lane behaving
exactly as its name says.

## The certificate

WebTransport will not accept an arbitrary self-signed certificate. For local development,
mint a short-lived one and pin it by hash:

```bash
openssl ecparam -name prime256v1 -genkey -noout -out key.pem
openssl req -new -x509 -key key.pem -out cert.pem -days 14 \
  -subj '/CN=localhost' -addext 'subjectAltName=DNS:localhost,IP:127.0.0.1'
```

ECDSA P-256 and at most 14 days are constraints `serverCertificateHashes` imposes, not
choices. Pass the SHA-256 of the certificate's DER bytes to `connectBrowser`.

## Where next

The [two lanes](/guides/lanes/) explains how to choose between them.
[`call()` and `stream()`](/guides/call-and-stream/) covers request shapes.
[Limitations](/limitations/) is worth reading before you commit to this.
