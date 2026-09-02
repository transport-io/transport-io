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
a QUIC datagram.

```ts
import { defineContract, type MapOf, reliable, rpc, streaming, unreliable } from 'transport-io'

export const contract = defineContract({
  chat: reliable<{ room: string; body: string }>(),
  cursor: unreliable<{ x: number; y: number }>(),
  save: rpc<{ text: string }, { revision: number }>(),
  ask: streaming<{ prompt: string }, string>(),
})

export interface AppMap extends MapOf<typeof contract> {}
```

`reliable` and `unreliable` take the payload. `rpc` and `streaming` take the payload and
what comes back: `save` answers with one value, `ask` with a sequence.

`AppMap` is passed at each construction site, which is what every example on this page does.
Registering it globally makes that argument implicit and is opt-in; see §7.

**Write both lines.** Without the second, every hover shows the whole contract with your
validator's internals in it. The measurement is in `DECISIONS.md`, D57 and D100.

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
do - and core has no runtime dependency on a validator:

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

Inbound payloads are validated; outbound are not.

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

Each transport module exports a **construct-and-connect** function that resolves to a
connected client. This is what an application writes:

```ts
import { browserClient } from 'transport-io/browser-transport'

export async function open(url: string): Promise<void> {
  const client = await browserClient<AppMap>({ contract, url })
  client.emit('chat', { room: 'lobby', body: 'hello' })
  client.disconnect()
}
```

| function | module | connection options |
|---|---|---|
| `browserClient<M>(options)` | `transport-io/browser-transport` | `url`, `certificateHash?` |
| `devClient<M>(options)` | `transport-io/dev-transport` | `endpoint?` |
| `http3Client<M>(options)` | `transport-io/node-transport` | `url`, `certificateHash` |

Each takes every `ClientOptions` field except `connect`, plus its transport's own options.

**`M` is never inferred from `contract`** (D100). Omitting the argument falls to `Registered`:
either the application registered a map, or the first `emit` fails with the sentence naming
the fix.
<!-- norm: client-map-never-inferred -> packages/core/src/transport-clients.test-d.ts -->

Which module you import decides where the code runs. `transport-io/browser-transport` uses
the platform's own `WebTransport` and loads nothing native. `transport-io/node-transport`
loads the QUIC binding and must only be imported from a file named `*.node.ts` - a lint rule
enforces that, because the binding segfaults Bun on exit.

### 2.0 Assembling it yourself

`new Client({ contract, connect })` takes the seam directly. **The one-call form hands back a
client that is already connected, so anything that needs the client before that constructs it
itself.**

Three cases qualify:

- **A transport of your own.** `connect` is the seam. Supply any function returning a
  `Connection`.
- **React.** `TransportProvider` takes an unconnected client and connects it in an effect, so
  the client has to exist synchronously, inside a `useState` initialiser.
- **Rendering connection state.** `connecting` is observable only if you are holding the
  thing doing the connecting. Both pages in `examples/chat` show a status indicator, and use
  the seam form for exactly that reason.

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
importing this module on a server - which Next.js will do - is safe. Feature detection
happens inside `connect()`.

**`connect()` and `disconnect()` are idempotent and refcounted**, so two components sharing
one client cannot tear down each other's connection. React StrictMode mounts twice in
development.

### 2.1 `call()`

An event declaring `returns` is callable. Each call opens its own bidirectional stream, so a
stalled call blocks nothing else.

```ts
export async function saveIt(): Promise<number> {
  const { revision } = await client.call('save', { text: 'hello' })
  return revision
}
```

**There is no default timeout.** A dead peer is detected by the QUIC idle timeout, which
closes the session and rejects every pending call. For a slow but live responder:

```ts
export async function saveWithDeadline(): Promise<number> {
  const res = await client.call('save', { text: 'hi' }, { signal: AbortSignal.timeout(5_000) })
  return res.revision
}
```

Aborting resets the QUIC stream. It is immediate, costs no application message, and the
responder's `ctx.signal` fires without the client sending anything.

A session is capped at 256 concurrent streams, shared by `call()` and `stream()`. The 257th
open is refused with `WT_TOO_MANY_STREAMS` and **the session stays up**. A call holds its
slot for a round trip; a
`stream()` holds one for as long as it runs, which is the unit that matters once §2.3 is in
use.

### 2.2 Responding

```ts
import { createServer } from 'transport-io'

export async function serve(): Promise<void> {
  const server = createServer<AppMap>({ contract })
  server.handle('save', async ({ text }) => ({ revision: text.length }))
  await server.listen()
}
```

`ctx.signal` fires when the caller aborts. A handler that returns promptly does not need to
consult it; one that does long work should, so the work stops when nobody is waiting for it.

`ctx.peer` is the `ServerPeer` that made the call. A responder is registered once and answers
every peer, so this is the only thing that says who is asking, and it is what lets a call
join its own caller to a room:

```ts
import type { Server } from 'transport-io'

export function installSave(server: Server<AppMap>): void {
  server.handle('save', async ({ text }, ctx) => {
    // The caller is known here, so the responder can act on it.
    await ctx.peer.join('editors')
    return { revision: text.length }
  })
}
```

`peer.id` is a value the server assigned itself and identifies nobody. Authenticate the
payload, then act on the peer.

A handler that throws produces a `CALL_ERROR` frame. Throw a `TransportError` to choose the
code; anything else becomes `WT_HANDLER_ERROR`.

### 2.3 `stream()`

An event declaring `yields` instead of `returns` answers with a **sequence**. The client
gets an async iterable, the server writes an async generator.

```ts
import type { Server } from 'transport-io'

export async function serveTokens(server: Server<AppMap>): Promise<void> {
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

Four helpers. `toArray()` takes the whole sequence, `take(n)` stops after `n` elements and closes the
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

They behave sequentially, and `cancel()` is this library's own (D99).

An error partway through is delivered after the elements that preceded it: the loop yields
what arrived, then throws. `toArray()` rejects and discards the partial. A cancelled stream
ends with `WT_ABORTED`, the same as an `AbortSignal`.

**Backpressure is accounted for.** The generator does not resume until its frame has been
accepted, and the responder may be at most **32 frames** ahead of what the consumer has
taken (D93).

`yields` and `returns` are mutually exclusive, and the choice is made in the contract.
`call()` on a streaming event refuses and names `stream()`. `stream()` on a call event
refuses and names `call()`.

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

**`getSnapshot()` returns the same reference until something changes**, so it is safe to hand
to `useSyncExternalStore`.

---

## 3. Server

```ts
type Conn = Awaited<ReturnType<ClientOptions['connect']>>

export async function start(incoming: { sessions(): AsyncIterable<Conn> }): Promise<void> {
  const server = createServer<AppMap>({ contract })

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

Passing a connection source hands `listen()` the accept loop. A rejected accept is counted in
`server.acceptErrors` and passed to `onAcceptError` if one is given; it does not stop the
loop, and it does not vanish. Call `listen()` with no argument and drive `accept()` yourself
when a connection has to be inspected before it is accepted.

### 3.1 Rooms are server-authoritative

A client cannot join by sending anything; only `peer.join()` on the server has that effect.
The client learns its membership from a notification, which is why `ClientState.rooms` is
accurate without the client ever asking. An application wanting client-initiated
subscription implements it as a `call` whose handler authorises the payload and then joins
`ctx.peer`, which is the shape the [reconnect
guide](https://transport-io.github.io/transport-io/guides/reconnect/) spells out.

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

`Server`, `ServerPeer` and `RoomTarget` each take the map, and each falls back to the
registered one if you opt into registration.

`server.memberCount(room)` returns how many local peers are in a room, counted on this
node rather than across the adapter. It is a number for a health endpoint or a log line, not
a presence feature: it cannot see peers connected to another node, and it says nothing about
who they are.

`emit` on a room returns a promise because it crosses the adapter, but delivery to local
members does not wait for it.

A broadcast to a room with no local members is not an error. Membership lives in the
adapter, and no node assumes it knows a room's full membership.

### 3.2 Per-peer accounting

```ts
export function report(peer: ServerPeer): string {
  const s = peer.stats()
  return `depth=${s.queueDepth} overflow=${s.overflowDropped} stale=${s.staleDropped} staleRx=${s.staleReceived}`
}
```

`overflowDropped` means a burst outran a bounded queue; `staleDropped` means a peer stalled
and the frames aged out. Both are **our** drops: the transport reports neither loss nor
congestion, so no count here is the network's.

---

### 3.3 Certificates, and the one error everyone hits first

Omit `certificateHash` and the connection is validated against the platform's CA store like
any other HTTPS origin. That is the production path. Pass one only to pin a self-signed
certificate locally, which is what `transport-io dev` sets up.

When a handshake fails, the browser gives the same `WebTransportError` - message
`Opening handshake failed.`, `code: 0`, no own properties - for a wrong hash, an expired
certificate, and a server that is not listening. Measured in Chromium; all three are
identical.

`connectBrowser` therefore raises `WT_HANDSHAKE_FAILED`, whose remedy lists those three in
the order worth ruling out, and keeps the browser's error as `cause`. It does not name a
single cause, because it cannot know which one it is.

`connectDev` can know, and does. The dev server publishes the certificate's expiry with its
hash, so an expired certificate raises `WT_CERT_EXPIRED` before any connection is attempted,
naming the command that mints a new one.

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
- **`WT_RELIABILITY_REFUSED`** means the session negotiated reliable-only transport and was
  refused, because the unreliable lane would otherwise become reliable and ordered.

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
messages, reorders deliveries, and fails on command. An adapter that only passes against
`MemoryAdapter` has not been tested.

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

Core imports no framework, not even as a type-only import, and holds no module-level
singleton or global mutable state.

A binding built on this surface is a few lines:

```tsx standalone
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

That block compiles like every other one here. It is also what `@transport-io/react` does for
you: [`useConnection`](https://transport-io.github.io/transport-io/guides/react/) is this plus
the connection calls, a stable return and a server snapshot.

---

## 7. `Register` (optional)

A map can be registered once, globally, and then omitted everywhere:

```ts standalone
import { Client, defineContract, type MapOf, reliable } from 'transport-io'

export const contract = defineContract({ chat: reliable<{ body: string }>() })
export interface AppMap extends MapOf<typeof contract> {}

declare module 'transport-io' {
  interface Register {
    map: AppMap
  }
}

// `Client`, `Server`, `ServerPeer` and `RoomTarget` now default to `AppMap`.
declare const client: Client
client.emit('chat', { body: 'hi' })
```

`Register` must stay an interface: only interfaces can be augmented by `declare module`, and
a type alias fails every registration with "Duplicate identifier". Without a registration,
`Registered` resolves to a sentinel whose only key is the instruction, so the first `emit`
fails with a message naming this block rather than with `never`.

**It changes no hover** (D100). What it removes is the type argument at construction.

**It is global.** One slot per process. Two contracts in the same process conflict, and the
type a file sees depends on which module was loaded rather than on what that file imported.
The explicit form has neither property: the type follows the import.

Nothing requires it, including `@transport-io/react`, which binds hooks to a map with
`createHooks<AppMap>()`.
