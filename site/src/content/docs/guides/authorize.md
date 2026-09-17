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

**Keep that token short-lived, because more than your server sees it.** When a handshake
fails, the browser prints its own console error with the whole URL, query included, and no
library can suppress it. Any log that records request paths has it too. This library keeps
the query out of its own errors, and that is as far as it reaches. So mint the token for the
connection and let it expire soon after: a day is too long for anything real.

## The door

`authorize` receives the request: `path`, `query`, and `peerAddress`. Return what you
learned, or refuse: `null`, or `refuse(reason)` to say why. The server's second type argument
is what `authorize` returns, and every `peer.data` and `ctx.peer.data` carries it:

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
There the URL comes from the dev manifest, so `devClient` and `connectDev` take the query
themselves. A function is called on every attempt, the first and each reconnect, so a token
refreshed since the last one is the one sent:

```ts file=dev-client.ts
import { devClient } from 'transport-io/dev-transport'
import { type AppMap, contract } from './contract.ts'

declare function currentToken(): Promise<string>

export const client = await devClient<AppMap>({
  contract,
  query: async () => ({ token: await currentToken() }),
})
```

The WebSocket listener takes `authorize` too, and its request carries the upgrade's
`headers`, cookies included, since that is an ordinary HTTP request.

## Refusing, with a reason

`refuse(reason)` refuses a peer and tells it why. The reason is a code the page compares,
not a sentence: it travels as the session's close reason, so it is 1 to 123 bytes and
`refuse` throws on anything longer. `null` is the reason `'refused'`.

```ts file=door.ts
import { refuse } from 'transport-io'
import type { User } from './contract.ts'

declare function lookup(token: string | null): Promise<(User & { banned: boolean }) | null>

export async function authorize({ query }: { query: URLSearchParams }) {
  const user = await lookup(query.get('token'))
  if (user === null) return refuse('expired')
  if (user.banned) return refuse('banned')
  return { name: user.name }
}
```

An `authorize` that throws has decided nothing, a database that is down, so it is not a
refusal: the session closes, and a client that reconnects keeps trying.

## What a refused peer sees

The session closes as `WT_UNAUTHORIZED` before the server sends anything, so a refused peer
receives the reason and never the event table. On the client, `connect()` rejects with a
`RefusedError`, whose `code` is `WT_UNAUTHORIZED` and whose `reason` is yours, and the
snapshot has `refused: { reason }` beside a `status` of `closed`:

```ts file=signin.ts
import { type Client, RefusedError } from 'transport-io'
import type { AppMap } from './contract.ts'

declare function showSignIn(): void
declare function showBanned(): void

export async function open(client: Client<AppMap>): Promise<void> {
  try {
    await client.connect()
  } catch (e) {
    if (!(e instanceof RefusedError)) throw e
    if (e.reason === 'banned') showBanned()
    else showSignIn()
  }
}
```

**A refusal is final.** It does not dial the fallback, and a client with `reconnect` stops
on it, since the same request would be refused again. A reconnect is a new request, so `authorize` runs again on each one,
and a token that expired while the page was open is refused there; `refused` on the snapshot
is how the page finds out. The way out is a credential that will pass, then `disconnect()`
and `connect()`.

A server can refuse a live session the same way, a token that expired mid-session:
`peer.close(CloseCode.WT_UNAUTHORIZED, 'expired')`.

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

Both moments arrive for a peer that vanished as well as for one that closed, up to 25
seconds later over WebTransport.
