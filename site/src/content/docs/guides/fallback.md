---
title: The fallback
description: The emit lane over a WebSocket, for browsers without WebTransport and networks that block UDP.
---

WebTransport needs a browser that has it and a network that lets UDP reach your server.
Where either is missing, the fallback carries the session over a WebSocket. It carries the
emit lane, and nothing else.

## What it does

A WebSocket is one ordered, reliable pipe in each direction, which is exactly what the emit
lane is. So over the fallback, `emit` works in both directions, rooms work, and the handshake,
the framing and reconnection behave as they do over WebTransport. An application that only
emits notices nothing but a field in the snapshot.

## What it does not do

`call()` and `stream()` are not on a fallback client. Each of them owns a QUIC stream of its
own, which is what lets one stalled call leave the others alone and lets an `AbortSignal`
reset exactly one of them. A WebSocket has one stream. A call on it would wait behind every
emit and every other call, and cancelling it would cancel nothing, so the fallback does not
offer them, and the type of a fallback client says so before anything runs.

## Unreliable events

The unreliable lane promises that a message may be dropped and that the newest one wins. A
WebSocket cannot drop anything, so it cannot carry an unreliable event as declared. An
unreliable event crosses the fallback only when the contract says what it accepts there:

```ts file=contract.ts
// contract.ts
import { defineContract, type MapOf, reliable, rpc, unreliable } from 'transport-io'

export const contract = defineContract({
  chat: reliable<{ from: string; body: string }>(),
  cursor: unreliable<{ x: number; y: number }>({ fallback: 'newest' }),
  save: rpc<{ text: string }, { revision: number }>(),
})
export interface AppMap extends MapOf<typeof contract> {}
```

`fallback: 'newest'` means: over the fallback, cursor positions travel on the emit lane, in
order. When that lane is backed up, the oldest queued positions are dropped at the sender and
stale ones are dropped before they are sent, exactly as the datagram ring drops them over
WebTransport, and the drops are counted in the same `overflowDropped` and `staleDropped`.
What arrives is the newest the sender could get out, in order.

An unreliable event that declares nothing blocks the fallback for the whole contract. The
line that adds one fails to compile, and the error names the event:

```text
Property ''fallback refused'' is missing in type '{ contract: ...; connect: ...; fallback: ...; }'
  but required in type '{ readonly 'fallback refused':
  "event 'cursor' is unreliable and declares no fallback"; }'.
```

## End to end

The client tries WebTransport first, every time, and takes the fallback only when the runtime
has no WebTransport or when the server answers over HTTPS and not over QUIC:

```ts file=client.ts
// client.ts
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

`withFallback` returns a `FallbackClient`: `emit`, `on`, `connect` and the rest, and no
`call` or `stream`. Those live on `native`, which is the client on a WebTransport session and
`null` on a fallback one, so the check is one the compiler will not let you skip:

```ts file=save.ts
// save.ts
import { client } from './client.ts'

export async function save(text: string): Promise<number | null> {
  const lanes = client.native
  if (lanes === null) return null
  const { revision } = await lanes.call('save', { text })
  return revision
}
```

The server keeps its WebTransport listener and adds a WebSocket one, in a `*.node.ts` file:

```ts file=server.node.ts
// server.node.ts
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
  server.withFallback(
    await listenWebSocket({ port: 443, host: '0.0.0.0', cert, privKey, path: '/transport-io' }),
  )
}
```

`server.withFallback` compiles under the same gate as the client. A session that reaches it
with an undeclared unreliable event is refused before the handshake with
`WT_RELIABILITY_REFUSED`, for the caller with no compiler. `peer.transport` says what carries
each peer, and a room can hold both kinds.

The WebSocket listener needs `ws`, an optional peer of `transport-io`. Install it where a
listener runs:

```bash
npm install ws
```

### Certificates

In production the listener is `wss://` on the certificate your site already serves, and the
WebSocket goes through any HTTPS proxy, which is the whole point of having it.

In development a browser pins no hash for a WebSocket, so the certificate `transport-io dev`
mints cannot serve one. Start the listener without `cert` and `privKey`, which makes it
`ws://`, and point the fallback at `ws://127.0.0.1:<port>/`. Loopback is a secure context, so
a page on `http://localhost` may open it.

## In React

`TransportProvider` takes a fallback client as it takes any other. On a fallback session,
`useCall` and `useStream` report `unavailable` before anything is asked, and asking does
nothing. `useNative()` is the client on a WebTransport session and `null` otherwise, for
anything the hooks do not cover.

```ts file=api.ts
// api.ts
import { createHooks } from '@transport-io/react'
import type { AppMap } from './contract.ts'

export const api = createHooks<AppMap>()
```

```tsx file=Save.tsx
// Save.tsx
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
the runtime has no WebTransport, or the server answers over HTTPS and not over QUIC. A dead
server, a wrong certificate hash or an expired one does not fall back; that error stands. A
reconnect starts from WebTransport again, so leaving a network that blocks UDP brings the
other lanes back on the next session, and a session never changes transport in place.

The snapshot says which. `transport` is `'webtransport'` or `'websocket'`, and `null` until
connected. `fallbackReason` is `'unsupported'` or `'unreachable'` on a fallback session and
`null` on a native one. `useConnection()` carries both.

## `WT_UDP_UNREACHABLE`

When a WebTransport handshake fails, the browser reports one error for every cause. After the
failure, and only then, the client asks whether the same origin answers over HTTPS: one `HEAD`
to `/.well-known/transport-io`, any status counts, two seconds at most. If it does, the
server is up and only the QUIC path is failing, which is what a firewall, a VPN or a platform
with no UDP ingress looks like, and the error is `WT_UDP_UNREACHABLE`. That is the signal the
fallback acts on.

It claims no more than that. It does not say what blocks UDP. It never fires for an origin
that listens only on UDP: that origin does not answer, and the error stays
`WT_HANDSHAKE_FAILED`. The WebSocket listener answers the probe on its port, so pointing
`probe` at it, or serving both on the same host, is what makes the signal exact. `probe` on
`connectBrowser` overrides the target, and `probe: false` disables it.

## What will bite

- **No idle timeout.** QUIC notices a dead path on its own; a WebSocket does not. A dead TCP
  path is noticed when the platform reports it, not before.
- **One pipe.** A large emit delays every emit behind it, in both directions.
- **`ws` is an install.** A server without it cannot listen for the fallback, and says so.
