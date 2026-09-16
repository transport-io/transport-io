---
title: Authenticating a peer
description: Decide each peer at the door with authorize, type what you learned as peer.data, and know when a peer leaves.
---

Nothing stands in front of the WebTransport endpoint: it is QUIC over UDP to your process,
and a proxy in front of it drops UDP. So the door is the listener's `authorize`. It runs for
each peer before the session is accepted, on the request that opened it, and what it returns
becomes `peer.data`.

## The token travels in the query

A browser sends no cookies and no custom headers on a WebTransport request. The path and the
query are all it can carry, so the page obtains a token over HTTPS and puts it in the URL it
connects to:

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

```ts file=client.ts
import { Client } from 'transport-io'
import { connectBrowser } from 'transport-io/browser-transport'
import { type AppMap, contract } from './contract.ts'

export function connect(token: string): Client<AppMap> {
  const url = new URL('https://example.com:4433/')
  url.searchParams.set('token', token)
  return new Client<AppMap>({ contract, connect: () => connectBrowser({ url: url.href }) })
}
```

## The door

`authorize` receives the request: `path`, `query`, and `peerAddress`. Return what you
learned, or `null` to refuse. The server's second type argument is what `authorize` returns,
and every `peer.data` and `ctx.peer.data` carries it:

```ts file=server.node.ts
import { createServer } from 'transport-io'
import { listenHttp3 } from 'transport-io/node-transport'
import { type AppMap, contract, type User } from './contract.ts'

declare const cert: string
declare const privKey: string
declare function userFor(token: string | null): Promise<User | null>

export async function main(): Promise<void> {
  const server = createServer<AppMap, User>({ contract })

  server.onSession((peer) => {
    void peer.join(`user:${peer.data.name}`)
    peer.on('chat', (msg) => {
      // The name comes from the door, not from the payload.
      void server.to('lobby').emit('chat', { ...msg, from: peer.data.name })
    })
  })

  await server.listen(
    await listenHttp3({
      port: 4433,
      cert,
      privKey,
      authorize: ({ query }) => userFor(query.get('token')),
    }),
  )
}
```

`listenDev` takes the same `authorize`, so the token flow works under `transport-io dev`.
The WebSocket listener takes it too, and its request carries the upgrade's `headers`, cookies
included, since that is an ordinary HTTP request.

## What a refused peer sees

The session closes as `WT_UNAUTHORIZED` before the server sends anything, so a refused peer
receives the reason and never the event table. On the client, `connect()` rejects with
`WT_UNAUTHORIZED` and the snapshot's `lastError` carries it. A refusal does not dial the
fallback: it is an answer, not a path to route around.

A reconnect is a new session and a new request, so `authorize` runs again with whatever the
URL carries then. A token that expires is refused on the next connect, which is where the
page fetches a fresh one.

## Without a door

A listener with no `authorize` accepts every peer, and `peer.data` is `undefined`. The
property is assignable, so a server that learns who a peer is later, from a call, can keep
it there:

```ts file=later.ts
import type { Server } from 'transport-io'
import type { AppMap, User } from './contract.ts'

export function attach(server: Server<AppMap, User | undefined>): void {
  server.onSession((peer) => {
    peer.on('chat', (msg) => {
      if (peer.data === undefined) return
      void server.to('lobby').emit('chat', { ...msg, from: peer.data.name })
    })
  })
}
```

## When a peer leaves

Two moments. `server.onDisconnecting` runs when the connection has closed and before the
peer leaves its rooms, so `peer.rooms` still says where it was. `peer.closed` settles after
the rooms are let go, so a `memberCount` read after it already reflects the departure.

```ts file=presence.ts
import type { Server } from 'transport-io'
import type { AppMap, User } from './contract.ts'

export function presence(server: Server<AppMap, User>): void {
  server.onDisconnecting((peer) => {
    for (const room of peer.rooms) {
      void server.to(room).emit('chat', { from: 'system', body: `${peer.data.name} left` })
    }
  })
}
```

QUIC notices a dead path with its idle timeout, and the WebSocket mapping with its own
deadline, so both moments arrive for a peer that vanished as well as for one that closed.
