# transport-io API

The TypeScript surface. Types are shown as they are, not described.

Every snippet in this document runs as written.

---

## 1. `defineContract`

The contract is the single source of truth. An agent or a human reading `contract.ts`
knows every event, payload and lane in the application without reading anything else. That
property is deliberate and is protected by the design.

```ts
import { defineContract, type Schema } from 'transport-io'
import { z } from 'zod'

export const contract = defineContract({
  chat:   { lane: 'stream',   payload: z.object({ room: z.string(), body: z.string() }) },
  cursor: { lane: 'datagram', payload: z.object({ x: z.number(), y: z.number() }) },
  save:   { lane: 'stream',
            payload: z.object({ docId: z.string(), text: z.string() }),
            returns: z.object({ revision: z.number() }) },
})

export interface AppMap extends MapOf<typeof contract> {}
```

**Write both lines.** The second is not decoration: it is what keeps every hover readable.
With it, hovering `emit` shows 126 characters. Without it — passing the contract inline —
it shows 303, including your validator's internal types. TypeScript preserves interface
names in hover but expands type-alias instantiations, so no library-side trick can remove
the need for the line. Every example in this document uses this form, and so should yours.

**The lane lives in the contract, never at the call site.** The guarantee belongs to the
message type, so client and server cannot disagree about it.

**An event with `returns` is callable; an event without it is emit-only.** That single
distinction is what separates the two call shapes, and it needs no second declaration.

### 1.1 Types

```ts
export type Lane = 'stream' | 'datagram'

/** Any validator implementing the Standard Schema interface: zod, valibot, arktype. */
export interface Schema<Output = unknown> {
  readonly '~standard': {
    readonly version: 1
    readonly vendor: string
    readonly validate: (value: unknown) =>
      | { readonly value: Output }
      | { readonly issues: readonly { readonly message: string }[] }
      | Promise<{ readonly value: Output } | { readonly issues: readonly { readonly message: string }[] }>
  }
}

/** `returns` is only meaningful on the stream lane: the datagram lane has no response path. */
export type EventDef =
  | { readonly lane: 'datagram'; readonly payload: Schema; readonly id?: number }
  | { readonly lane: 'stream'; readonly payload: Schema; readonly returns?: Schema; readonly id?: number }

export type Contract = Readonly<Record<string, EventDef>>

export declare function defineContract<const C extends Contract>(contract: C): C
```

### 1.2 Inference strategy

Two helpers, each one level deep. This is a deliberate constraint: deeply conditional
inferred types produce hover output and error messages that neither humans nor agents can
read. If `emit` hover shows forty lines of conditional type, the design has failed.

```ts
/** Derive a plain payload/returns map once, so no method signature ever mentions a schema. */
export type MapOf<M extends AnyMap> = {
  readonly [K in keyof C]: {
    readonly payload: Infer<C[K]['payload']>
    readonly returns: C[K] extends { readonly returns: infer R extends Schema }
      ? Infer<R> : never
  }
}

export interface EventShape { readonly payload: unknown; readonly returns: unknown }
export type AnyMap = Readonly<Record<string, EventShape>>

/** Events with a `returns`, and therefore callable. */
export type CallableOf<M extends AnyMap> =
  { [K in keyof M]: [M[K]['returns']] extends [never] ? never : K }[keyof M]
```

Deriving the map once is what keeps hover short: `Client` is parameterised by `AppMap`
rather than by the raw contract, so a signature never has to print your schemas. Measured
on the contract above — `emit` hover 361 characters before, 126 after, with the validator's
types gone entirely.

A wrong event name or a wrong payload shape fails to compile, and the error names the
event and the offending field rather than unrolling the contract type. There is a
type-level test asserting exactly that.

### 1.3 Types-only contracts

For applications that want inference without runtime validation:

```ts
import { defineContract, type$ } from 'transport-io'

export const contract = defineContract({
  ping: { lane: 'datagram', payload: type$<{ t: number }>() },
})
```

`type$<T>()` returns a `Schema<T>` whose validation is the identity function. It adds no
dependency and no runtime cost.

---

## 2. Server

### 2.1 Creating a server

```ts
import { createServer } from 'transport-io/server'
import { readFileSync } from 'node:fs'
import { contract } from './contract.js'

const server = createServer({
  contract,
  port: 4433,
  cert: readFileSync('cert.pem', 'utf8'),
  privKey: readFileSync('key.pem', 'utf8'),
})

await server.listen()
```

```ts
export interface ServerOptions<M extends AnyMap> {
  readonly contract: Contract
  readonly port: number
  readonly cert: string
  readonly privKey: string
  readonly host?: string
  readonly path?: string
  readonly adapter?: Adapter
  readonly validateInbound?: boolean
}

export interface Server<M extends AnyMap> {
  listen(): Promise<void>
  close(): Promise<void>
  readonly address: { readonly host: string; readonly port: number } | null

  on(event: 'session', handler: (session: Session<M>) => void): () => void
  on(event: 'error', handler: (error: TransportError) => void): () => void

  to(room: string): RoomTarget<M>
  handle<K extends CallableOf<M>>(
    event: K,
    handler: (payload: M[K]['payload'], ctx: CallContext<M>) => Promise<M[K]['returns']>,
  ): () => void
}
```

`host` defaults to `'::'`, `path` to `'/'`, `adapter` to a `MemoryAdapter`, and
`validateInbound` to `true`. Outbound payloads are never validated: the process that
produced a payload does not need to check its own work, and validating twice doubles the
cost on the hot path.

### 2.2 Session lifecycle

```ts
server.on('session', (session) => {
  session.join('lobby')

  session.on('chat', (payload) => {
    server.to('lobby').emit('chat', payload)
  })

  session.closed.then((info) => {
    console.log('gone:', session.id, info.code, info.reason)
  })
})
```

```ts
export interface Session<M extends AnyMap> {
  readonly id: PeerId
  readonly rooms: readonly string[]
  readonly closed: Promise<CloseInfo>

  join(room: string): Promise<void>
  leave(room: string): Promise<void>

  emit<K extends keyof M>(event: K, payload: M[K]['payload']): void
  on<K extends keyof M>(event: K, handler: (payload: M[K]['payload']) => void): () => void

  stats(): PeerStats
  close(code?: number, reason?: string): void
}

export type PeerId = string

export interface CloseInfo {
  readonly code: number
  readonly reason: string
}

/** Per-peer queue accounting. These are OUR drops, not the network's — see PROTOCOL.md §9. */
export interface PeerStats {
  readonly queueDepth: number
  /** Dropped because the bounded queue was full. */
  readonly overflowDropped: number
  /** Dropped at dequeue because the frame outlived its TTL. */
  readonly staleDropped: number
  /** Discarded on receipt because the sequence was not newer. */
  readonly staleReceived: number
}
```

`PeerId` is a stable string that is meaningful across processes. It is never an object
reference, because it crosses the adapter boundary.

**Rooms are server-authoritative.** A client cannot join by sending anything; only
`session.join()` on the server has that effect. An application wanting client-initiated
subscription implements it as a call, which is already on the authenticated path.

### 2.3 Emitting to a room

```ts
server.to('lobby').emit('chat', { room: 'lobby', body: 'hello' })
server.to('lobby').except(session.id).emit('cursor', { x: 10, y: 20 })
```

```ts
export interface RoomTarget<M extends AnyMap> {
  emit<K extends keyof M>(event: K, payload: M[K]['payload']): void
  except(...peers: PeerId[]): RoomTarget<M>
}
```

`emit` returns `void` rather than a promise. Delivery is queued per peer under the policy
in `PROTOCOL.md` §9; awaiting it would let one slow peer stall the whole broadcast, which
is the failure this design exists to prevent.

A broadcast to a room with no local members is not an error. Membership lives in the
adapter, and no node is assumed to know a room's full membership.

### 2.4 Handling a call

```ts
server.handle('save', async ({ docId, text }, ctx) => {
  ctx.signal.throwIfAborted()
  const revision = await db.save(docId, text)
  return { revision }
})
```

```ts
export interface CallContext<M extends AnyMap> {
  readonly session: Session<M>
  readonly signal: AbortSignal
}
```

`ctx.signal` aborts when the client cancels. Because a cancelled call is a QUIC stream
reset, the abort is immediate and costs no application message — the handler learns about
it without the client sending anything.

A handler that throws produces a `CALL_ERROR` frame. Throw a `TransportError` to control
the code; anything else becomes `WT_HANDLER_ERROR`.

---

## 3. Client

### 3.1 Connecting

```ts
import { Client } from 'transport-io/client'
import { contract } from './contract.js'

const client = new Client({ contract, url: 'https://localhost:4433/' })
await client.connect()
```

```ts
export interface ClientOptions<M extends AnyMap> {
  readonly contract: Contract
  readonly url: string
  readonly certificateHashes?: readonly Uint8Array[]
  readonly validateInbound?: boolean
}

export declare class Client<M extends AnyMap> {
  constructor(options: ClientOptions<C>)

  connect(): Promise<void>
  disconnect(): void

  emit<K extends keyof M>(event: K, payload: M[K]['payload']): void
  call<K extends CallableOf<M>>(
    event: K,
    payload: M[K]['payload'],
    options?: { readonly signal?: AbortSignal },
  ): Promise<M[K]['returns']>

  on<K extends keyof M>(event: K, handler: (payload: M[K]['payload']) => void): () => void
  on(event: 'session', handler: (info: SessionInfo) => void): () => void
  on(event: 'error', handler: (error: TransportError) => void): () => void

  subscribe(listener: () => void): () => void
  getSnapshot(): ClientState
}
```

**`new Client(...)` performs no I/O.** It touches neither `window` nor `WebTransport`, so
importing this module on a server — which Next.js will do — is safe. Feature detection
happens inside `connect()` and throws `WT_NO_SUPPORT` when the runtime has no
WebTransport. There is no fallback; an unsupported runtime is unsupported.

`connect()` and `disconnect()` are idempotent and refcounted. Two components sharing one
client cannot tear down each other's connection, which matters because React StrictMode
mounts twice in development.

### 3.2 Emit and call

```ts
client.emit('cursor', { x: 12, y: 40 })

const { revision } = await client.call('save', { docId: 'a', text: 'hi' })
```

`emit` is fire and forget on both lanes. `call` is available only on events declaring
`returns`; using it on an emit-only event is a compile error.

**There is no default call timeout.** A dead peer is detected by the QUIC idle timeout,
which closes the session and rejects every pending call with `WT_SESSION_CLOSED` — so the
case a timeout is usually reached for is already handled. Adding a default timer would
reintroduce exactly the pending-callback bookkeeping this design removes. For a slow but
live handler, pass a signal:

```ts
const res = await client.call('save', doc, { signal: AbortSignal.timeout(5_000) })
```

Aborting resets the QUIC stream. The server's `ctx.signal` fires immediately and no
application message is sent in either direction.

### 3.3 Session events

```ts
client.on('session', ({ id, resumed }) => {
  console.log('session', id, 'resumed:', resumed)
})
```

```ts
export interface SessionInfo {
  readonly id: string
  readonly resumed: boolean
}
```

`resumed` is always `false` in this version. It exists so that genuine resumption can
arrive later as a negotiated feature rather than a redesign.

**Reconnection creates a new session.** Room membership does not survive it, and pending
calls reject. Re-establishing application state is the application's job; this library
provides the primitive and the hook.

---

## 4. Errors

```ts
export declare class TransportError extends Error {
  readonly code: TransportErrorCode
  readonly remedy: string
}

export type TransportErrorCode =
  | 'WT_NO_SUPPORT' | 'WT_DATAGRAM_TOO_LARGE' | 'WT_ROOM_NOT_JOINED' | 'WT_SESSION_CLOSED'
  | 'WT_ABORTED' | 'WT_HANDLER_ERROR' | 'WT_PROTOCOL_ERROR' | 'WT_UNSUPPORTED_CODEC'
  | 'WT_PAYLOAD_TOO_LARGE' | 'WT_HANDSHAKE_INCOMPLETE' | 'WT_UNKNOWN_EVENT'
  | 'WT_VALIDATION_FAILED' | 'WT_PROTOCOL_VERSION_MISMATCH' | 'WT_CONTRACT_MISMATCH'
  | 'WT_HANDSHAKE_TIMEOUT' | 'WT_PEER_TOO_SLOW' | 'WT_TOO_MANY_STREAMS'
  | 'WT_RELIABILITY_REFUSED'
```

Every error carries a stable code and a `remedy` sentence saying what to do about it. A
bare `TypeError` is never thrown from this library's own surface. Codes and their meanings
are specified in `PROTOCOL.md` §10.

---

## 5. Adapters

```ts
export interface Adapter {
  join(room: string, peer: PeerId): Promise<void>
  leave(room: string, peer: PeerId): Promise<void>
  broadcast(
    room: string,
    frame: Frame,
    opts: { readonly lane: Lane; readonly except?: readonly PeerId[] },
  ): Promise<void>
  onRemote(cb: (room: string, frame: Frame) => void): void
}

export type Frame = Uint8Array
```

`MemoryAdapter` ships in core and is the default, so installing this library and running it
requires no infrastructure and no configuration.

Every method is async even in memory, frames cross as bytes rather than live objects, and
any method may reject — a rejected `broadcast` is reported on the `error` channel and does
not tear down the session. Core degrades rather than crashing.

`HostileAdapter` is exported from `transport-io/testing` for conformance work. It
serialises every frame, adds latency, redelivers the publisher's own messages, reorders
deliveries and fails on command. The conformance suite runs against both, because an
interface with one implementor is usually wrong and `MemoryAdapter` is a misleading sole
implementor.

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

```ts
export interface ClientState {
  readonly status: 'idle' | 'connecting' | 'connected' | 'closing' | 'closed'
  readonly sessionId: string | null
  readonly rooms: readonly string[]
  readonly lastError: TransportError | null
}
```

**`getSnapshot()` returns the same reference until something actually changes.** Returning
a freshly built object on each call makes `useSyncExternalStore` re-render forever. This is
the single most common way this shape is implemented incorrectly, so there is an explicit
test pinning it rather than a note asking implementers to be careful.

Core imports no framework, ever — not React, not Next, not even as a type-only import — and
holds no module-level singleton or global mutable state, because that breaks request
isolation on the server and makes tests order-dependent.

A binding built on this surface looks like:

```ts
import { useSyncExternalStore } from 'react'

export function useConnectionStatus(client: Client<never>) {
  return useSyncExternalStore(
    (cb) => client.subscribe(cb),
    () => client.getSnapshot().status,
    () => 'idle' as const,
  )
}
```
