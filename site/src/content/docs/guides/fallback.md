---
title: The fallback
description: The emit lane over a WebSocket, for browsers without WebTransport and networks that block UDP.
---

WebTransport needs a browser that has it and a network that lets UDP reach your server.
Where either is missing, the fallback carries the session over a WebSocket: the emit lane,
and nothing else. WebTransport over HTTP/2 is the specification's own fallback and is not
usable: Chrome and Firefox do not implement it.

## What it does

A WebSocket is one ordered, reliable pipe in each direction, which is what the emit lane is.
Over the fallback, `emit` works both ways, rooms work, and the handshake, the framing and
reconnection are unchanged. An application that only emits notices nothing but a field in
the snapshot.

## What it does not do

`call()` and `stream()` are not on a fallback client. Each owns its own QUIC stream, so a
stalled call leaves the others alone and an `AbortSignal` resets exactly one. A WebSocket has
one stream: a call on it would wait behind every emit and every
other call, and cancelling it would cancel nothing. So the fallback does not offer them, and
the type of a fallback client says so before anything runs.

## Unreliable events

The unreliable lane promises that a message may be dropped and the newest wins. A WebSocket
drops nothing, so it cannot carry an unreliable event as declared. One crosses the fallback
only when the contract says what it accepts there:

```ts file=contract.ts
import { defineContract, type MapOf, reliable, rpc, unreliable } from 'transport-io'

export const contract = defineContract({
  chat: reliable<{ from: string; body: string }>(),
  cursor: unreliable<{ x: number; y: number }>({ fallback: 'newest' }),
  save: rpc<{ text: string }, { revision: number }>(),
})
export interface AppMap extends MapOf<typeof contract> {}
```

`fallback: 'newest'` means cursor positions travel on the emit lane, in order. When that lane
is backed up, the sender drops the oldest queued and the stale, as the datagram ring does over
WebTransport, counted in the same `overflowDropped` and `staleDropped`. What arrives is the
newest the sender could get out.

An unreliable event that declares nothing blocks the fallback for the whole contract. The
line that adds one fails to compile, naming the event:

```text
Property ''fallback refused'' is missing in type '{ contract: ...; connect: ...; fallback: ...; }'
  but required in type '{ readonly 'fallback refused':
  "event 'cursor' is unreliable and declares no fallback"; }'.
```

## End to end

The client tries WebTransport first, every time, and takes the fallback when the runtime has
no WebTransport or the WebTransport handshake fails and the WebSocket connects:

```ts file=client.ts
import { withFallback } from 'transport-io'
import { connectBrowser } from 'transport-io/browser-transport'
import { connectWebSocket } from 'transport-io/websocket-transport'
import { type AppMap, contract } from './contract.ts'

export const client = withFallback<AppMap>({
  contract,
  connect: () => connectBrowser({ url: 'https://example.com:4433/' }),
  fallback: () => connectWebSocket({ url: 'wss://example.com/transport-io' }),
})
```

`withFallback` returns a `FallbackClient`: everything but `call` and `stream`. Those live on
`native`, the client on a WebTransport session and `null` on a fallback one, so the compiler
makes the check unavoidable:

```ts file=save.ts
import { client } from './client.ts'

export async function save(text: string): Promise<number | null> {
  const lanes = client.native
  if (lanes === null) return null
  const { revision } = await lanes.call('save', { text })
  return revision
}
```

The server keeps its WebTransport listener and adds a WebSocket one, in a `*.node.ts` file.
This is the shape behind a reverse proxy, which terminates `wss://` and forwards to the
local port:

```ts file=server.node.ts
import { createServer } from 'transport-io'
import { listenHttp3 } from 'transport-io/node-transport'
import { listenWebSocket } from 'transport-io/websocket-node-transport'
import { type AppMap, contract } from './contract.ts'

declare const cert: string
declare const privKey: string

export async function main(): Promise<void> {
  const server = createServer<AppMap>({ contract })
  server.handle('save', async ({ text }) => ({ revision: text.length }))
  server.onSession((peer) => {
    void peer.join('lobby')
    peer.on('chat', (msg) => void server.to('lobby').emit('chat', msg))
    peer.on('cursor', (pos) => void server.to('lobby').except(peer.id).emit('cursor', pos))
  })

  await server.listen(await listenHttp3({ port: 4433, host: '0.0.0.0', cert, privKey }))
  server.withFallback(await listenWebSocket({ port: 8081, path: '/transport-io' }))
}
```

With nothing in front of the process, the listener terminates TLS itself:

```ts file=tls.node.ts title="server.node.ts, with nothing in front of the process"
import type { Server } from 'transport-io'
import { listenWebSocket } from 'transport-io/websocket-node-transport'
import type { AppMap } from './contract.ts'

declare const cert: string
declare const privKey: string

export async function fallback(server: Server<AppMap>): Promise<void> {
  server.withFallback(
    await listenWebSocket({ port: 443, host: '0.0.0.0', cert, privKey, path: '/transport-io' }),
  )
}
```

`server.withFallback` compiles under the same gate as the client, and a session with an
undeclared unreliable event is refused before the handshake with `WT_RELIABILITY_REFUSED`.
`peer.transport` says what carries each peer; a room can hold both.

### Certificates

The WebTransport listener's certificate is covered in [Certificates](/guides/certificates/).
For the WebSocket listener, what is in front of the process decides the shape.

**Behind a reverse proxy**, which is most deployments: nginx, Caddy, a load balancer, a
platform ingress. Start the listener on a local port with no `cert` or `privKey`; the proxy
terminates `wss://` on the certificate it already holds. This is what lets the fallback
reach a network WebTransport cannot: it is ordinary TCP on 443, which any proxy already
forwards.

**Terminating TLS in the process**, with nothing in front of it. Pass `cert` and `privKey`,
sharing the site's certificate, and bind the port the browser will reach.

**In development**, `ws://` on loopback. A browser pins no hash for a WebSocket, so the
certificate `transport-io dev` mints cannot serve one. Point the fallback at
`ws://127.0.0.1:<port>/`; loopback is a secure context, so a page on `http://localhost` may
open it.

## In React

`TransportProvider` takes a fallback client as it takes any other. On a fallback session,
`useCall` and `useStream` report `unavailable` before anything is asked, and asking does
nothing. `useNative()` is the client on a WebTransport session and `null` otherwise, for
anything the hooks do not cover.

```ts file=api.ts
import { createHooks } from '@transport-io/react'
import type { AppMap } from './contract.ts'

export const api = createHooks<AppMap>()
```

```tsx file=Save.tsx
import type { ReactNode } from 'react'
import { api } from './api.ts'

export function Save(): ReactNode {
  const [save, state] = api.useCall('save')
  if (state.status === 'unavailable') return <p>not on this connection</p>
  return (
    <button type="button" onClick={() => void save({ text: 'hello' })}>
      Save
    </button>
  )
}
```

## How the switch is decided

Every connect starts from WebTransport. The fallback engages on two conditions and no other:
the runtime has no WebTransport, or the WebTransport handshake fails and the WebSocket
connects. A dead server fails both and reports the WebTransport error. A wrong or expired
pinned hash fails the handshake as a blocked path does, and falls back the same way. A
reconnect starts from WebTransport again, so leaving a network that blocks UDP brings the
other lanes back on the next session, and a session never changes transport in place.

The snapshot says which. `transport` is `'webtransport'` or `'websocket'`, `null` until
connected. `fallbackReason` is `'unsupported'` or `'unreachable'` on a fallback session,
`null` on a native one. `useConnection()` carries both.

## `WT_UDP_UNREACHABLE`

When a WebTransport handshake fails, the browser reports one error for every cause. After the
failure, the client asks whether the same origin answers over HTTPS: one `HEAD` to
`/.well-known/transport-io`, any status counts, two seconds at most. An answer means the
server is up and only the QUIC path is failing, which is what a firewall, a VPN or a platform
with no UDP ingress looks like, and the error is `WT_UDP_UNREACHABLE`.

It claims no more. It does not say what blocks UDP, and it never fires for an origin that
listens only on UDP: nothing answers, and the error stays `WT_HANDSHAKE_FAILED`. The fallback
does not depend on it; with a WebSocket configured, the WebSocket handshake is the test.
`probe` points it at another origin, such as the WebSocket listener's, which answers it, and
`probe: false` disables it.

## What will bite

- **No idle timeout.** QUIC notices a dead path on its own; a WebSocket does not. A dead TCP
  path is noticed when the platform reports it.
- **One pipe.** A large emit delays every emit behind it, in both directions.
