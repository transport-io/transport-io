# transport-io for coding agents

The whole API in one pass. What the exports are, what the contract looks like, what the
errors mean. No marketing.

If you write against this library, the two things most likely to trip you are: **the lane
is declared in the contract, never at the call site**, and **`call()` only exists on events
that declare `returns`**. Everything else follows from those.

---

## Install

```
npm install transport-io
npm install @fails-components/webtransport-transport-http3-quiche   # server only
```

The native package is a separate deliberate install. It is not a dependency of anything -
only a dynamic import - so no package manager pulls it in. Browsers need nothing extra.

Node ≥ 22. TypeScript ≥ 5.0 for consumers.

## Entry points

| import | contains | runs where |
|---|---|---|
| `transport-io` | contract, `Client`, `createServer`, errors, `MemoryAdapter` | anywhere |
| `transport-io/browser-transport` | `connectBrowser` | browser |
| `transport-io/node-transport` | `listenHttp3`, `connectHttp3` | Node only |
| `transport-io/testing` | `HostileAdapter`, `loopbackPair`, `UnreliableConnection` | tests |

`transport-io/node-transport` loads a native addon that segfaults Bun on exit. Only import
it from a file named `*.node.ts`.

## The contract - always two lines

```ts
import { defineContract, type MapOf, type$ } from 'transport-io'

export const contract = defineContract({
  chat:   { lane: 'reliable',   payload: type$<{ from: string; body: string }>() },
  cursor: { lane: 'unreliable', payload: type$<{ x: number; y: number }>() },
  save:   { lane: 'reliable',   payload: type$<{ text: string }>(),
            returns: type$<{ revision: number }>() },
})

export interface AppMap extends MapOf<typeof contract> {}
```

**Write the second line.** It is not optional style. For the contract above,
`Client<AppMap>` hovers `emit` at 107 characters and `Client<MapOf<typeof contract>>` at 353,
with the validator's internal
types in it, because TypeScript preserves interface names and expands alias
instantiations. Every example everywhere uses this form.

`payload` accepts any Standard Schema validator - zod, valibot, arktype - or `type$<T>()`
for inference with no runtime validation. Inbound payloads are validated; outbound are not.

### Rules the contract enforces

- Lanes name guarantees. `reliable` is carried on QUIC streams, `unreliable` on QUIC
  datagrams. Never write `lane: 'stream'` or `lane: 'datagram'`: those were the 0.1.0
  spellings and they no longer exist.
- `returns` is valid **only** on `lane: 'reliable'`. An unreliable event has no response
  path, and the type refuses it.
- An event's wire id is the first four bytes of SHA-256 of its **name**, so adding or
  removing events is rolling-deploy safe. Two names that collide are a build-time error
  naming both; set an explicit `id` on one rather than renaming.

## Client

```ts
import { Client } from 'transport-io'
import { connectBrowser } from 'transport-io/browser-transport'

const client = new Client<AppMap>({
  contract,
  connect: () => connectBrowser({ url: 'https://example.com:4433/' }),
})

await client.connect()

client.emit('chat', { from: 'me', body: 'hi' })          // lane comes from the contract
const off = client.on('chat', (p) => console.log(p.body)) // returns an unsubscribe
off()

const { revision } = await client.call('save', { text: 'hi' })
const res = await client.call('save', { text: 'hi' }, { signal: AbortSignal.timeout(5000) })
void res

client.disconnect()
```

| member | notes |
|---|---|
| `new Client(opts)` | Does no I/O. Safe to import and construct on a server. |
| `connect()` / `disconnect()` | Idempotent and refcounted. Two components sharing a client cannot tear each other down. |
| `emit(event, payload)` | Fire and forget, on whichever lane the contract declared. |
| `call(event, payload, opts?)` | Only on events with `returns`. No default timeout. |
| `on(event, handler)` | Returns an unsubscribe function. There is no `off()`. |
| `subscribe(cb)` / `getSnapshot()` | For `useSyncExternalStore`. `getSnapshot` is referentially stable. |
| `stats()` | Per-peer drop counters. |

`ClientState` is `{ status, sessionId, rooms, lastError }` where `status` is
`'idle' | 'connecting' | 'connected' | 'closing' | 'closed'`.

## Server

```ts
import { createServer } from 'transport-io'
import { listenHttp3 } from 'transport-io/node-transport'   // in a *.node.ts file

const server = createServer<AppMap>({ contract })
await server.listen()

server.handle('save', async ({ text }, ctx) => {
  ctx.signal.throwIfAborted()          // fires when the caller aborts
  return { revision: text.length }
})

server.onSession((peer) => {
  void peer.join('lobby')
  peer.on('chat', (msg) => void server.to('lobby').emit('chat', msg))
  peer.on('cursor', (pos) => void server.to('lobby').except(peer.id).emit('cursor', pos))
})

declare const cert: string    // PEM, from your own certificate source
declare const privKey: string // PEM

const listener = await listenHttp3({ port: 4433, cert, privKey })
for await (const conn of listener.sessions()) void server.accept(conn)
```

**Rooms are server-authoritative.** A client cannot join by sending anything; only
`peer.join()` does it, and the client learns membership from a notification. If you want
client-initiated subscription, make it an ordinary event you handle on the server, where
you can apply whatever authorization your application has. **This library authenticates
nothing** and gives a handler no peer identity beyond `peer.id`, which it assigned itself -
so "handle it on the server" means your check runs there, not that anyone has been
identified. See PROTOCOL.md §3.

`server.to(room).emit()` returns a promise because it crosses the adapter, but local
delivery does not wait for it. Broadcasting to a room with no members is not an error.

## Errors

Every error is a `TransportError` with a `code` and a `remedy` sentence. A bare `TypeError`
is never thrown from this library.

| code | means | do |
|---|---|---|
| `WT_NO_SUPPORT` | runtime has no WebTransport | nothing - there is no fallback |
| `WT_DATAGRAM_TOO_LARGE` | payload past the path limit | shorten it, or use the reliable lane |
| `WT_ROOM_NOT_JOINED` | broadcast to a room this session is not in | join first |
| `WT_SESSION_CLOSED` | session closed while an operation was pending | reconnect and retry |
| `WT_ABORTED` | the caller aborted | routine, not a fault |
| `WT_HANDLER_ERROR` | a `handle()` callback threw | inspect server logs |
| `WT_UNKNOWN_EVENT` | event not in the contract | check the spelling, or deploy both sides |
| `WT_VALIDATION_FAILED` | payload failed its schema | fix the payload |
| `WT_TOO_MANY_STREAMS` | over 256 concurrent calls on one session | reduce concurrency; the session stays up |
| `WT_PROTOCOL_VERSION_MISMATCH` | peers disagree on protocol major | deploy both sides together |
| `WT_CONTRACT_MISMATCH` | an event's lane or id differs across peers | align the contract |
| `WT_HANDSHAKE_TIMEOUT` | no handshake within 5s | usually an unsupported browser |
| `WT_PEER_TOO_SLOW` | emit queue hit 256 frames | the peer was disconnected |
| `WT_RELIABILITY_REFUSED` | session negotiated reliable-only | refused rather than lie about the unreliable lane |
| `WT_UNSUPPORTED_CODEC` | codec other than JSON | send codec `0x01` |
| `WT_PAYLOAD_TOO_LARGE` | frame over its cap | use a call, or split |
| `WT_PROTOCOL_ERROR` | malformed frame | check against `PROTOCOL.md` |
| `WT_HANDSHAKE_INCOMPLETE` | traffic before the handshake | await `connect()` first |

## Behaviour worth knowing before you debug it

**Datagrams may be dropped, duplicated or reordered.** Duplicates and stale arrivals are
discarded for you. Loss is never reported, because loss is the contract. `stats()` returns
`overflowDropped` (a burst outran the 64-frame ring), `staleDropped` (a frame aged past its
150 ms TTL while queued) and `staleReceived` (a duplicate or out-of-order arrival) - all of
them **our** counters, never the network's.

**The emit lane blocks across rooms.** One stream per direction carries every room, so a
busy room delays a quiet one to the same peer. Calls and datagrams are isolated.

**Reconnect is a new session.** Membership does not survive; pending calls reject.

**There is no default call timeout.** Peer death is caught by the QUIC idle timeout. Use
`AbortSignal.timeout(ms)` for a slow but live responder.

**Chrome and Firefox only.** Safari establishes a session and then never sends, which
surfaces as `WT_HANDSHAKE_TIMEOUT`.

## Writing an adapter

```ts
// A skeleton that must satisfy the real interface, rather than a copy of it. If `Adapter`
// changes, this block stops compiling - a retyped interface would just quietly go stale.
import type {
  Adapter,
  AdapterFrame,
  BroadcastOptions,
  PeerId,
  RemoteEnvelope,
} from 'transport-io'

class MyAdapter implements Adapter {
  // The identity stamped into every envelope you publish, and the one core dedupes
  // against. One per node - sharing an adapter instance between two servers gives them
  // one identity and breaks the dedup in both directions.
  readonly nodeId = 'node-a'

  async join(room: string, peer: PeerId): Promise<void> {}
  async leave(room: string, peer: PeerId): Promise<void> {}
  async broadcast(room: string, frame: AdapterFrame, opts: BroadcastOptions): Promise<void> {}
  onRemote(cb: (envelope: RemoteEnvelope) => void): void {}
}
```

Run the conformance suite against `HostileAdapter` from `transport-io/testing`, not just
`MemoryAdapter`. It serialises frames through bytes, adds latency, reorders, duplicates,
echoes the publisher's own messages and fails on command. An adapter that only passes
against an in-memory map has not been tested.

Every method may reject; core degrades rather than crashing. Frames cross as bytes, never
live objects. No node may assume it knows a room's full membership.

## Streaming responses

An event declaring `yields` instead of `returns` answers with a sequence. Server writes an
async generator, client consumes an async iterable:

```ts standalone
import { Client, createServer, defineContract, type MapOf, type$ } from 'transport-io'

export const c = defineContract({
  ask: { lane: 'reliable', payload: type$<{ prompt: string }>(), yields: type$<string>() },
})
export interface AskMap extends MapOf<typeof c> {}

export async function serveAsk(): Promise<void> {
  const server = createServer<AskMap>({ contract: c })
  await server.listen()
  server.handle('ask', async function* ({ prompt }, ctx) {
    for (const word of prompt.split(' ')) {
      ctx.signal.throwIfAborted()
      yield word
    }
  })
}

export async function consume(client: Client<AskMap>): Promise<string[]> {
  const out: string[] = []
  for await (const token of client.stream('ask', { prompt: 'a b c' })) {
    out.push(token)
    if (out.length === 2) break
  }
  return out
}
```

Rules that will bite you if you guess:

- `yields` and `returns` are **mutually exclusive**. `call()` on a `yields` event throws and
  names `stream()`; `stream()` on a `returns` event throws and names `call()`.
- **`break` is the cancel.** It resets the QUIC stream, fires the handler's `ctx.signal`, and
  runs any `finally` in the generator. There is no `.cancel()`. `{ signal }` does the same
  from outside the loop.
- `.collect()` gives the whole sequence as one array. It **rejects** on a mid-stream error
  rather than resolving with the partial.
- An error partway through delivers the elements that preceded it, then throws. Elements are
  never retracted.
- A yielding handler may run at most **32 frames** ahead of what the consumer has taken. That
  window is this library's own accounting, not the transport's.
- A stream holds one of the session's 256 stream slots for its whole life, not for a round
  trip.

## Not implemented

Namespaces, presence, middleware chains, binary codecs, framework bindings, the Redis
adapter.

## Where to look next

`PROTOCOL.md` for the wire format, `API.md` for full types, `DECISIONS.md` for why anything
is the way it is.
