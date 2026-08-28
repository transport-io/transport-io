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
shows 107 characters; without it, 377, including your validator's internal types. Hover
width is a property of the contract rather than of the library, so those figures belong to
the contract pinned in the project's hover gate and are re-measured on every CI run.

## The server

```ts
import { createServer } from 'transport-io'
import { listenHttp3 } from 'transport-io/node-transport'

// From your own configuration: see "The certificate" below.
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
import { Client } from 'transport-io'
import { connectBrowser } from 'transport-io/browser-transport'

// The SHA-256 of your certificate's DER bytes, and your own render functions.
declare const certificateHash: Uint8Array
declare function render(from: string, body: string): void
declare function moveDot(x: number, y: number): void

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
dot moves in the other, with some frames missing.

## The certificate

WebTransport will not accept an arbitrary self-signed certificate. For local development,
mint a short-lived one and pin it by hash:

```bash
openssl ecparam -name prime256v1 -genkey -noout -out key.pem
openssl req -new -x509 -key key.pem -out cert.pem -days 14 \
  -subj '/CN=localhost' -addext 'subjectAltName=DNS:localhost,IP:127.0.0.1'
```

ECDSA P-256 and a maximum of 14 days are constraints imposed by
`serverCertificateHashes`. Pass the SHA-256 of the certificate's DER bytes to
`connectBrowser`.

## Where next

[The two lanes](/guides/lanes/) covers choosing between them.
[`call()` and `stream()`](/guides/call-and-stream/) covers request shapes.
[Limitations](/limitations/) is worth reading before you commit to this.
