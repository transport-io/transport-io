---
title: Rooms
description: Server-authoritative membership, and what a reconnect does to it.
---

A room is a name. Peers join it and the server broadcasts to it. Nothing about a room is
persisted.

```ts
import {
  type Client,
  defineContract,
  type MapOf,
  reliable,
  rpc,
  type Server,
  TransportError,
  unreliable,
} from 'transport-io'

const contract = defineContract({
  chat: reliable<{ body: string }>(),
  cursor: unreliable<{ x: number; y: number }>(),
  subscribe: rpc<{ room: string }, { joined: boolean }>(),
})
interface AppMap extends MapOf<typeof contract> {}

declare const server: Server<AppMap, { name: string }>
declare const client: Client<AppMap>
declare function allowed(room: string): boolean
declare function resubscribe(): Promise<void>

server.onSession((peer) => {
  void peer.join('lobby')
  peer.on('chat', (msg) => void server.to('lobby').emit('chat', msg))
})
```

Register `peer.on` handlers in `onSession` itself, before any `await`. Nothing the peer sent
is delivered until the callback returns, so a handler registered there cannot miss the peer's
first event, and one registered after an `await` can.

## Membership is server-authoritative

A client cannot join a room by sending a frame. There is no `client.join()`, and a
client-sent `JOIN` is a protocol error.

Room membership is an authorisation decision, and only the server knows who the peer is. If
you want client-initiated subscription, implement it as a `call()` and check the request
before joining:

```ts
// Registered once, at startup. `server.handle` is global, so registering it inside
// `onSession` would re-register on every connection and capture whichever peer connected
// last - a call from one peer would then join a different one. `ctx.peer` is the caller.
server.handle('subscribe', async ({ room }, ctx) => {
  if (!allowed(room)) {
    throw new TransportError('WT_ROOM_NOT_JOINED', 'not yours', 'Ask an admin.')
  }
  await ctx.peer.join(room)
  return { joined: true }
})
```

Clients still learn their own membership. The server sends `JOIN` and `LEAVE` frames to keep
`client.getSnapshot().rooms` accurate. Those frames report a decision the server has already
made.

## Broadcasting

```ts
declare const msg: { body: string }
declare const pos: { x: number; y: number }
declare const peer: { id: string }

server.to('lobby').emit('chat', msg)                    // everyone in the room
server.to('lobby').except(peer.id).emit('cursor', pos)  // everyone but the sender
```

`except` is worth using on the unreliable lane. Echoing a peer's own cursor position back to
it wastes bandwidth that a fresher frame could use.

## Order

Everything this node sends one peer on the reliable lane leaves on that peer's one emit
stream in the order it was handed, whichever API handed it: `peer.emit`, a broadcast to a
room the peer is in, and the join notification. So history sent with `peer.emit` before
`peer.join` arrives before anything the room sends after the join, and a broadcast issued
before a `peer.emit` arrives before it. Local members are handed a broadcast before the
adapter is consulted, so awaiting the broadcast is not what orders it.

Two things have no order against that stream. A call's response travels on its own stream,
so returning history from a call and then joining the room is a race; send it with
`peer.emit` instead. And a broadcast from another node arrives when the adapter delivers it,
ordered with that node's other broadcasts and not with this node's direct emits. The
unreliable lane has no order at all.

## Messaging one user

There is no API for it, and none is needed. A room per identity handles several tabs where
a peer id cannot, since each tab is its own peer:

```ts
server.onSession((peer) => {
  void peer.join(`user:${peer.data.name}`)
})

export function whisper(to: string, from: string, body: string): Promise<void> {
  // The recipient's tabs, and the sender's other tabs.
  void server.to(`user:${from}`).emit('chat', { body })
  return server.to(`user:${to}`).emit('chat', { body })
}

export const online = (name: string): boolean => server.memberCount(`user:${name}`) > 0
```

`peer.data.name` is what [`authorize`](/guides/authorize/) returned at the door.
`memberCount` counts this node's members only, so `online` is an answer for one process.

## Knowing a peer left

`server.onDisconnecting((peer, info) => …)` runs when a peer's connection has closed and
before it leaves its rooms, so `peer.rooms` still says where it was. `peer.closed` is a
promise that settles after the rooms are let go, so a `memberCount` read after it already
reflects the departure. [Authenticating a peer](/guides/authorize/) has both with a presence
example.

A peer that closes departs at once. A peer that vanishes, a killed tab or a dead network,
departs when the transport notices, up to 25 seconds later over WebTransport, with close code
`0` and a reason that begins `connection lost`. Until then it is still in its rooms.

## A reconnect is a new session

Room membership does not survive a reconnect. Pending calls reject.

Rejoining is your code, not the library's (D4). `onSession` runs once for every session
the client gets, the first and each reconnect, and returns its own unsubscribe:

```ts
const stopWatching = client.onSession(() => void resubscribe())
```

Dropping the unsubscribe leaks the listener for the lifetime of the client. Call
`stopWatching()` when the component or process that installed it goes away.

[Reconnecting](/guides/reconnect/) has the whole recipe: authorising the rejoin, catching up
on what was missed, and the guard that stops two catch-ups overlapping.

## Scaling past one process

`MemoryAdapter` is the default and needs no infrastructure. For more than one server
process, implement the `Adapter` interface: frames cross it as bytes, never live objects,
and every method is async.

Test yours against `HostileAdapter` from `transport-io/testing`. It serialises through
bytes, adds latency, reorders, duplicates and fails on command.
