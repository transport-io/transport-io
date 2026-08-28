# transport-io API

The TypeScript surface as it exists today. Every signature below is the real declaration.

**Every snippet in this document is extracted and typechecked against the built package in
CI.** When the API changes, the docs stop compiling and the build breaks.

---

## 1. `defineContract`

The contract is the single source of truth. Reading `contract.ts` tells you every event,
payload and lane in the application without reading anything else.

A lane is a guarantee. `reliable` means the message arrives, in order; it is carried on a
QUIC stream. `unreliable` means it may be dropped, duplicated or reordered; it is carried on
a QUIC datagram. The name says what your data gets, not how it travels.

```ts
import { defineContract, type MapOf, reliable, rpc, streaming, unreliable } from 'transport-io'

export const contract = defineContract({
  chat: reliable<{ room: string; body: string }>(),
  cursor: unreliable<{ x: number; y: number }>(),
  save: rpc<{ text: string }, { revision: number }>(),
  ask: streaming<{ prompt: string }, string>(),
})

export interface AppMap extends MapOf<typeof contract> {}

declare module 'transport-io' {
  interface Register {
    map: AppMap
  }
}
```

`reliable` and `unreliable` take the payload. `rpc` and `streaming` take the payload and
what comes back: `save` answers with one value, `ask` with a sequence. The `declare module` block registers the map, so no `Client` or
`createServer` in the application carries a type argument; every example on this page relies
on it.

**Write both lines.** The second is what keeps every hover readable.
With it, hovering `emit` shows 107 characters. Without it - passing the contract inline -
it shows 377, and that is with TypeScript's own elision hiding part of the validator's
internals. `call` is 169 against 439, and `stream` 157 against 427. Every figure is for the
contract pinned in `scripts/check-hover.ts` and is re-measured on each run; a different
contract gives different numbers. TypeScript preserves interface
names in hover but expands type-alias instantiations, so no library-side trick removes the
need for the line.

**The lane lives in the contract, never at the call site.** The guarantee belongs to the
<!-- norm: lane-lives-in-the-contract -> packages/core/src/lane-integrity.test.ts -->
message type, so client and server cannot disagree about it.

### 1.1 A type, or a schema

Every helper takes either a type argument or a schema, and both give the same payload types
to the rest of the application. What differs is what happens at runtime.

A type argument, as in the contract above, is types-only: nothing checks it and it costs
nothing at runtime. A peer that sends the wrong shape reaches your handler.

A schema validates every inbound payload on arrival, at one check per message. `payload`
accepts anything implementing the Standard Schema interface - zod, valibot and arktype all
do - so core has no runtime dependency on a validator and your validator's types never
appear in ours:

```ts standalone
import { defineContract, type MapOf, reliable, rpc } from 'transport-io'
import { z } from 'zod'

export const validated = defineContract({
  chat: reliable(z.object({ room: z.string(), body: z.string().max(2000) })),
  save: rpc(z.object({ text: z.string() }), z.object({ revision: z.number() })),
})

export interface ValidatedMap extends MapOf<typeof validated> {}
```

A payload the schema rejects never reaches a handler; the sender's call fails with
`WT_VALIDATION_FAILED` and an emit is dropped. Use a schema wherever a peer you do not
control can reach, which for a server is every client. Use a type argument where both ends
are yours and the traffic is high.

`type$<T>()` is the same types-only schema the helpers build for you, exported for the
object form below.

Inbound payloads are validated; outbound are not. The process that produced a payload does
not need to check its own work, and validating twice doubles the cost on the hot path.

### 1.2 Event identity

An event's wire id is the first four bytes of SHA-256 of its name, so **adding or removing
an event changes no existing identifier** and a contract change survives a rolling deploy.
Two names whose hashes collide are a build-time error naming both events; set an explicit
`id` on one rather than renaming your domain language.

```ts
export const withOverride = defineContract({
  chat: { ...reliable<{ body: string }>(), id: 0x31e06f7d },
})
```

### 1.3 The object form

A helper returns a plain object, and `defineContract` accepts one written out. This is the
form to use when a contract is assembled programmatically, where a helper call cannot be
written literally:

```ts standalone
import { defineContract, type MapOf, type$ } from 'transport-io'

export const explicit = defineContract({
  chat: { lane: 'reliable', payload: type$<{ body: string }>() },
  cursor: { lane: 'unreliable', payload: type$<{ x: number; y: number }>() },
  save: { lane: 'reliable', payload: type$<{ text: string }>(), returns: type$<number>() },
  ask: { lane: 'reliable', payload: type$<{ prompt: string }>(), yields: type$<string>() },
})

export interface ExplicitMap extends MapOf<typeof explicit> {}
```

`rpc` and `streaming` are both `lane: 'reliable'`: a call and a stream are carried on their
own QUIC stream, so there is no unreliable variant of either. The rest of this page uses the
helpers.

---

## 2. Client

A `Connection` comes from the transport seam, and which one you import decides where the
code runs. `transport-io/browser-transport` uses the platform's own `WebTransport` and
loads nothing native. `transport-io/node-transport` loads the QUIC binding and must only be
imported from a file named `*.node.ts` - a lint rule enforces that, because the binding
segfaults Bun on exit.

```ts
import { Client, type ClientOptions } from 'transport-io'

// Supplied by the transport seam, so this module never imports a transport.
declare const openConnection: ClientOptions['connect']

export const client = new Client({ contract, connect: openConnection })

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
importing this module on a server - which Next.js will do - is safe. Feature detection
happens inside `connect()`.

**`connect()` and `disconnect()` are idempotent and refcounted**, so two components sharing
one client cannot tear down each other's connection. React StrictMode mounts twice in
development.

### 2.1 `call()`

An event declaring `returns` is callable. Each call opens its own bidirectional stream, so
the stream *is* the correlation: no identifiers, no pending map, and a stalled call blocks
nothing else.

```ts
export async function saveIt(): Promise<number> {
  const { revision } = await client.call('save', { text: 'hello' })
  return revision
}
```

**There is no default timeout.** A dead peer is detected by the QUIC idle timeout, which
closes the session and rejects every pending call - the case a timeout is usually reached
for is already handled. Adding a default timer would reintroduce exactly the
pending-callback bookkeeping this design removes. For a slow but live responder:

```ts
export async function saveWithDeadline(): Promise<number> {
  const res = await client.call('save', { text: 'hi' }, { signal: AbortSignal.timeout(5_000) })
  return res.revision
}
```

Aborting resets the QUIC stream. It is immediate, costs no application message, and the
responder's `ctx.signal` fires without the client sending anything. On a WebSocket this
would need an app-level protocol and the peer would keep working until it heard you.

A session is capped at 256 concurrent streams, shared by `call()` and `stream()`. The 257th
open is refused with `WT_TOO_MANY_STREAMS` and **the session stays up** - a leaking handler
must not take the other 256 down with it. A call holds its slot for a round trip; a
`stream()` holds one for as long as it runs, which is the unit that matters once §2.3 is in
use.

### 2.2 Responding

```ts
import { createServer } from 'transport-io'

export async function serve(): Promise<void> {
  const server = createServer({ contract })
  server.handle('save', async ({ text }) => ({ revision: text.length }))
  await server.listen()
}
```

`ctx.signal` fires when the caller aborts. A handler that returns promptly does not need to
consult it; one that does long work should, so the work stops when nobody is waiting for it.

A handler that throws produces a `CALL_ERROR` frame. Throw a `TransportError` to choose the
code; anything else becomes `WT_HANDLER_ERROR`.

### 2.3 `stream()`

An event declaring `yields` instead of `returns` answers with a **sequence**. The client
gets an async iterable, the server writes an async generator.

```ts
import type { Server } from 'transport-io'

export async function serveTokens(server: Server): Promise<void> {
  server.handle('ask', async function* ({ prompt }) {
    for (const token of prompt.split(' ')) {
      yield token
    }
  })
}

export async function render(): Promise<string[]> {
  const out: string[] = []
  for await (const token of client.stream('ask', { prompt: 'one two three' })) {
    out.push(token)
    if (out.length === 2) break // resets the stream; the handler's `finally` runs
  }
  return out
}
```

The handler above never consults `ctx.signal`. It does not need to: the responder checks
before asking the generator for another value, so a cancelled stream stops without every
loop repeating that check.

**`break` is the cancel.** Leaving the loop calls the iterator's `return()`, which resets the
QUIC stream, which fires the handler's `ctx.signal` and runs any `finally` inside the
generator. An `AbortSignal` option does the same from outside the loop, which is what a
React effect cleanup would use:

```ts
export async function withDeadline(): Promise<number> {
  let n = 0
  const s = client.stream('ask', { prompt: 'a b c' }, { signal: AbortSignal.timeout(5_000) })
  for await (const _ of s) n++
  return n
}
```

Four helpers cover the cases where a loop reads worse than the thing it is doing.
`toArray()` takes the whole sequence, `take(n)` stops after `n` elements and closes the
stream exactly as `break` does, `forEach(fn)` awaits `fn` before pulling the next element so
a slow callback slows the producer, and `cancel()` stops a stream from outside its loop:

```ts
export async function whole(): Promise<string[]> {
  return await client.stream('ask', { prompt: 'a b c' }).toArray()
}

export async function firstTwo(): Promise<string[]> {
  return await client.stream('ask', { prompt: 'a b c' }).take(2).toArray()
}

export async function stoppable(stop: { onclick: () => void }): Promise<void> {
  const gen = client.stream('ask', { prompt: 'a b c' })
  stop.onclick = () => gen.cancel()
  await gen.forEach(async (token) => void console.log(token))
}
```

They are named after the TC39 async iterator helpers and behave sequentially. That proposal
is being revised to let `take` and others run several pulls at once, which would defeat the
credit window, so this library will not follow it there. `cancel()` is not in the proposal.

An error partway through is delivered after the elements that preceded it: the loop yields
what arrived, then throws. `toArray()` rejects and discards the partial, because a partial
array returned as if it were the whole answer is worse than an error. A cancelled stream
ends with `WT_ABORTED`, the same as an `AbortSignal`.

**Backpressure is accounted for, not assumed.** The generator does not resume until its
frame has been accepted, and the responder may be at most **32 frames** ahead of what the
consumer has taken. That window is this library's own accounting, not the transport's: measured on the reference binding, a `WritableStreamDefaultWriter`'s `ready`
resolves unconditionally, and without the window a producer ran 136,523 frames and roughly
53 MB ahead of a consumer that had taken 40. See ADR 0012.

`yields` and `returns` are mutually exclusive, and the choice is made in the contract.
`call()` on a streaming event refuses and names `stream()`. `stream()` on a call event
refuses and names `call()`.

The shape has to be fixed in the contract because a handler that yields nothing closes the
stream with zero response frames, which is the same on the wire as a broken `call()`
responder. The contract is what distinguishes an empty sequence from a fault.

A streaming call holds one of the session's 256 stream slots for as long as it runs, not for
a round trip. Ten concurrent generations use ten slots for minutes at a time.

### 2.4 Observable state

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
type Conn = Awaited<ReturnType<ClientOptions['connect']>>

export async function start(incoming: { sessions(): AsyncIterable<Conn> }): Promise<void> {
  const server = createServer({ contract })

  server.onSession((peer) => {
    void peer.join('lobby')
    peer.on('chat', (payload) => {
      void server.to('lobby').emit('chat', payload)
    })
    peer.on('cursor', (payload) => {
      void server.to('lobby').except(peer.id).emit('cursor', payload)
    })
  })

  await server.listen(incoming)
}
```

`listen()` is async because event ids are a SHA-256 of the event name, and the table is built
once at start rather than per message.

Passing a connection source hands `listen()` the accept loop. A rejected accept is counted in
`server.acceptErrors` and passed to `onAcceptError` if one is given; it does not stop the
loop, and it does not vanish. Call `listen()` with no argument and drive `accept()` yourself
when a connection has to be inspected before it is accepted.

### 3.1 Rooms are server-authoritative

A client cannot join by sending anything; only `peer.join()` on the server has that effect.
The client learns its membership from a notification, which is why `ClientState.rooms` is
accurate without the client ever asking. An application wanting client-initiated
subscription implements it as an ordinary event handled on the server, which is already on
the authenticated path.

```ts
import type { RoomTarget, ServerPeer } from 'transport-io'

export async function moveRooms(peer: ServerPeer): Promise<readonly string[]> {
  await peer.join('lobby')
  await peer.leave('lobby')
  return peer.rooms
}

export function narrow(target: RoomTarget, exclude: string): RoomTarget {
  return target.except(exclude)
}
```

`Server`, `ServerPeer` and `RoomTarget` default to the registered map, so an annotation
needs no type argument either.

`server.memberCount(room)` returns how many local peers are in a room, counted on this
node rather than across the adapter. It is a number for a health endpoint or a log line, not
a presence feature: it cannot see peers connected to another node, and it says nothing about
who they are.

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
number covering both would be unactionable. Both are **our** drops - the transport reports
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
<!-- norm: no-bare-typeerror -> packages/core/src/api-hardening.test.ts -->
wire values are specified in `PROTOCOL.md` §10, and a test asserts the two agree.

Two worth knowing:

- **`WT_DATAGRAM_TOO_LARGE`** is raised by this library before the transport sees the
  write, because the transport accepts an oversized datagram, discards it, and reports
  success.
- **`WT_RELIABILITY_REFUSED`** means the session negotiated reliable-only transport. The
  unreliable lane would silently become reliable and ordered, so the session is refused
  rather than allowed to lie about your data.

---

## 5. Adapters

```ts
import { MemoryAdapter, type Adapter, type PeerId } from 'transport-io'

export const adapter: Adapter = new MemoryAdapter('node-1')

export async function fanOut(a: Adapter, room: string, peer: PeerId): Promise<void> {
  await a.join(room, peer)
  await a.broadcast(room, new Uint8Array([1, 2, 3]), { lane: 'reliable', except: [peer] })
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
any method may reject - a rejected `broadcast` leaves local members served and the session
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

Core imports no framework, ever - not React, not Next, not even as a type-only import - and
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
