# transport-io API

The TypeScript surface as it exists today. Types are shown as they are, not described.

**Every snippet in this document is extracted and typechecked against the built package in
CI.** When the API changes, the docs stop compiling and the build breaks.

> **Not built yet.** `stream()` is specified in `PROTOCOL.md` and is not implemented.
> Everything else below runs: contracts, both lanes, rooms, `call()`, and the client and
> server surfaces. Nothing below is aspirational.

---

## 1. `defineContract`

The contract is the single source of truth. Reading `contract.ts` tells you every event,
payload and lane in the application without reading anything else.

```ts
import { defineContract, type MapOf, type$ } from 'transport-io'

export const contract = defineContract({
  chat: { lane: 'stream', payload: type$<{ room: string; body: string }>() },
  cursor: { lane: 'datagram', payload: type$<{ x: number; y: number }>() },
})

export interface AppMap extends MapOf<typeof contract> {}
```

**Write both lines.** The second is not decoration: it is what keeps every hover readable.
With it, hovering `emit` shows 126 characters. Without it — passing the contract inline —
it shows 303, including your validator's internal types. TypeScript preserves interface
names in hover but expands type-alias instantiations, so no library-side trick removes the
need for the line.

**The lane lives in the contract, never at the call site.** The guarantee belongs to the
message type, so client and server cannot disagree about it.

### 1.1 Validation is bring-your-own

`payload` accepts anything implementing the Standard Schema interface — zod, valibot and
arktype all do — so core has no runtime dependency on a validator and your validator's
types never appear in ours. `type$<T>()` is the types-only escape hatch used above: it
infers without validating and costs nothing at runtime.

Inbound payloads are validated; outbound are not. The process that produced a payload does
not need to check its own work, and validating twice doubles the cost on the hot path.

### 1.2 Event identity

An event's wire id is the first four bytes of SHA-256 of its name, so **adding or removing
an event changes no existing identifier** and a contract change survives a rolling deploy.
Two names whose hashes collide are a build-time error naming both events; set an explicit
`id` on one rather than renaming your domain language.

```ts
export const withOverride = defineContract({
  chat: { lane: 'stream', payload: type$<{ body: string }>(), id: 0x31e06f7d },
})
```

---

## 2. Client

A `Connection` comes from the transport seam, and which one you import decides where the
code runs. `transport-io/browser-transport` uses the platform's own `WebTransport` and
loads nothing native. `transport-io/node-transport` loads the QUIC binding and must only be
imported from a file named `*.node.ts` — a lint rule enforces that, because the binding
segfaults Bun on exit.

```ts
import { Client, type ClientOptions } from 'transport-io'

// Supplied by the transport seam, so this module never imports a transport.
declare const openConnection: ClientOptions['connect']

export const client = new Client<AppMap>({ contract, connect: openConnection })

export async function main(): Promise<void> {
  await client.connect()
  client.emit('chat', { room: 'lobby', body: 'hello' })
  client.emit('cursor', { x: 12, y: 40 })
  const off = client.on('chat', (payload) => {
    console.log(payload.room, payload.body)
  })
  off()
}
```

`emit` is fire and forget on both lanes; which lane is decided by the contract. A wrong
event name or a wrong payload shape fails to compile, and the error names the event:

```
Argument of type '"chatt"' is not assignable to parameter of type '"chat" | "cursor"'.
```

**`new Client(...)` performs no I/O.** It touches neither `window` nor `WebTransport`, so
importing this module on a server — which Next.js will do — is safe. Feature detection
happens inside `connect()`.

**`connect()` and `disconnect()` are idempotent and refcounted**, so two components sharing
one client cannot tear down each other's connection. React StrictMode mounts twice in
development.

### 2.1 `call()`

An event declaring `returns` is callable. Each call opens its own bidirectional stream, so
the stream *is* the correlation: no identifiers, no pending map, and a stalled call blocks
nothing else.

```ts
import { defineContract as dc, type MapOf as M, type$ as t$, Client as C } from 'transport-io'

export const rpc = dc({
  save: { lane: 'stream', payload: t$<{ text: string }>(), returns: t$<{ revision: number }>() },
})
export interface RpcMap extends M<typeof rpc> {}
declare const rpcClient: C<RpcMap>

export async function saveIt(): Promise<number> {
  const { revision } = await rpcClient.call('save', { text: 'hello' })
  return revision
}
```

**There is no default timeout.** A dead peer is detected by the QUIC idle timeout, which
closes the session and rejects every pending call — the case a timeout is usually reached
for is already handled. Adding a default timer would reintroduce exactly the
pending-callback bookkeeping this design removes. For a slow but live responder:

```ts
export async function saveWithDeadline(): Promise<number> {
  const res = await rpcClient.call('save', { text: 'hi' }, { signal: AbortSignal.timeout(5_000) })
  return res.revision
}
```

Aborting resets the QUIC stream. It is immediate, costs no application message, and the
responder's `ctx.signal` fires without the client sending anything. On a WebSocket this
would need an app-level protocol and the peer would keep working until it heard you.

A session is capped at 256 concurrent call streams. The 257th open is refused with
`WT_TOO_MANY_STREAMS` and **the session stays up** — a leaking handler must not take the
other 256 calls down with it.

### 2.2 Responding

```ts
import { createServer as cs } from 'transport-io'

export async function serve(): Promise<void> {
  const server = cs<RpcMap>({ contract: rpc })
  await server.listen()
  server.handle('save', async ({ text }, ctx) => {
    ctx.signal.throwIfAborted()
    return { revision: text.length }
  })
}
```

A handler that throws produces a `CALL_ERROR` frame. Throw a `TransportError` to choose the
code; anything else becomes `WT_HANDLER_ERROR`.

### 2.3 Observable state

```ts
import type { ClientState } from 'transport-io'

export function watch(client: Client, log: (s: ClientState) => void): () => void {
  log(client.getSnapshot())
  return client.subscribe(() => log(client.getSnapshot()))
}
```

```ts
import type { Status } from 'transport-io'

declare const state: ClientState
declare const status: Status
export const fields: [Status, string | null, readonly string[]] = [
  state.status,
  state.sessionId,
  state.rooms,
]
export const known: Status[] = ['idle', 'connecting', 'connected', 'closing', 'closed']
void status
```

**`getSnapshot()` returns the same reference until something changes.** Returning a freshly
built object each call makes `useSyncExternalStore` re-render forever, which is the single
most common way this shape is implemented incorrectly. There is an explicit test pinning it.

---

## 3. Server

```ts
import { createServer } from 'transport-io'

type Conn = Awaited<ReturnType<ClientOptions['connect']>>

export async function start(incoming: AsyncIterable<Conn>): Promise<void> {
  const server = createServer<AppMap>({ contract })
  await server.listen()

  server.onSession((peer) => {
    void peer.join('lobby')
    peer.on('chat', (payload) => {
      void server.to('lobby').emit('chat', payload)
    })
    peer.on('cursor', (payload) => {
      void server.to('lobby').except(peer.id).emit('cursor', payload)
    })
  })

  for await (const conn of incoming) void server.accept(conn)
}
```

`listen()` is async because event ids are a SHA-256 of the event name, and the table is
built once at start rather than per message.

### 3.1 Rooms are server-authoritative

A client cannot join by sending anything; only `peer.join()` on the server has that effect.
The client learns its membership from a notification, which is why `ClientState.rooms` is
accurate without the client ever asking. An application wanting client-initiated
subscription implements it as an ordinary event handled on the server, which is already on
the authenticated path.

```ts
import type { RoomTarget, ServerPeer } from 'transport-io'

export async function moveRooms(peer: ServerPeer<AppMap>): Promise<readonly string[]> {
  await peer.join('lobby')
  await peer.leave('lobby')
  return peer.rooms
}

export function narrow(target: RoomTarget<AppMap>, exclude: string): RoomTarget<AppMap> {
  return target.except(exclude)
}
```

`emit` on a room returns a promise because it crosses the adapter, but delivery to local
members does not wait for it. Awaiting each peer inside a broadcast loop would let one slow
client stall the whole room, which is the failure this design exists to prevent.

A broadcast to a room with no local members is not an error. Membership lives in the
adapter, and no node assumes it knows a room's full membership.

### 3.2 Per-peer accounting

```ts
export function report(peer: ServerPeer): string {
  const s = peer.stats()
  return `depth=${s.queueDepth} overflow=${s.overflowDropped} stale=${s.staleDropped} staleRx=${s.staleReceived}`
}
```

`overflowDropped` and `staleDropped` are counted separately on purpose: the first means a
burst outran a bounded queue, the second means a peer stalled and the frames aged out. One
number covering both would be unactionable. Both are **our** drops — the transport reports
neither loss nor congestion, so no count here claims to be the network's.

---

## 4. Errors

```ts
import { TransportError, type TransportErrorCode } from 'transport-io'

export function describe(e: unknown): string {
  if (e instanceof TransportError) {
    const code: TransportErrorCode = e.code
    return `${code}: ${e.remedy}`
  }
  return 'unknown'
}
```

Every error carries a stable code and a `remedy` sentence saying what to do about it. A
bare `TypeError` is never thrown from this library's own surface. Codes and their numeric
wire values are specified in `PROTOCOL.md` §10, and a test asserts the two agree.

Two worth knowing:

- **`WT_DATAGRAM_TOO_LARGE`** is raised by this library before the transport sees the
  write, because the transport accepts an oversized datagram, discards it, and reports
  success.
- **`WT_RELIABILITY_REFUSED`** means the session negotiated reliable-only transport. The
  datagram lane would silently become reliable and ordered, so the session is refused
  rather than allowed to lie about your data.

---

## 5. Adapters

```ts
import { MemoryAdapter, type Adapter, type PeerId } from 'transport-io'

export const adapter: Adapter = new MemoryAdapter('node-1')

export async function fanOut(a: Adapter, room: string, peer: PeerId): Promise<void> {
  await a.join(room, peer)
  await a.broadcast(room, new Uint8Array([1, 2, 3]), { lane: 'stream', except: [peer] })
}
```

`MemoryAdapter` ships in core and is the default, so installing this library and running it
needs no infrastructure and no configuration.

**If you write an adapter, run the conformance suite against `HostileAdapter` too.** It is
exported from `transport-io/testing` and behaves like a bus rather than a map: it
serialises every frame through bytes, adds latency, delivers the publisher its own
messages, reorders deliveries, and fails on command. `MemoryAdapter` is synchronous,
infallible and omniscient about membership, so an adapter that only passes against it has
not been tested against anything.

```ts
import { HostileAdapter } from 'transport-io/testing'

export const hostile = new HostileAdapter('node-1', {
  latencyMs: 1,
  reorder: true,
  duplicate: true,
})
hostile.failNextBroadcast = true // core must degrade, not crash
```

Every method is async even in memory, frames cross as bytes rather than live objects, and
any method may reject — a rejected `broadcast` leaves local members served and the session
up. Core degrades rather than crashing.

A node receiving its own publish back is normal, and core dedupes by originating node
rather than relying on the adapter to suppress it.

---

## 6. Framework binding surface

The exact set of core APIs a framework binding consumes. A change to anything listed here
is a change to the binding contract, and breaking it should be visible rather than
discovered downstream.

| API | why a binding needs it |
|---|---|
| `new Client(options)` | Constructible without I/O, so it can be created in a module or a provider. |
| `client.connect()` / `client.disconnect()` | Idempotent and refcounted, for effect setup and teardown under StrictMode. |
| `client.subscribe(listener)` | The `subscribe` half of `useSyncExternalStore`. Returns an unsubscribe function. |
| `client.getSnapshot()` | The `getSnapshot` half. **Returns a referentially stable frozen object.** |
| `client.on(event, handler)` | Returns an unsubscribe function, making effect cleanup a one-liner. |
| `TransportError.code` | Lets a binding branch on a stable code rather than a message. |

Core imports no framework, ever — not React, not Next, not even as a type-only import — and
holds no module-level singleton or global mutable state, because that breaks request
isolation on the server and makes tests order-dependent.

A binding built on this surface is a few lines:

```ts ignore
import { useSyncExternalStore } from 'react'
import type { Client, Status } from 'transport-io'

export function useConnectionStatus(client: Client): Status {
  return useSyncExternalStore(
    (cb) => client.subscribe(cb),
    () => client.getSnapshot().status,
    () => 'idle' as const,
  )
}
```

That last block is tagged `ignore` because React is not a dependency of this repository and
never will be. It is the only exempt block in this document.
