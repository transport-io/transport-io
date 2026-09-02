---
title: Rooms
description: Server-authoritative membership, and what a reconnect does to it.
---

A room is a name. Peers join it and the server broadcasts to it. Nothing about a room is
persisted.

```ts
import {
  type Client,
  type ClientState,
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

declare const server: Server<AppMap>
declare const client: Client<AppMap>
declare function allowed(room: string): boolean
declare function resubscribe(): Promise<void>

server.onSession((peer) => {
  void peer.join('lobby')
  peer.on('chat', (msg) => void server.to('lobby').emit('chat', msg))
})
```

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

## A reconnect is a new session

Room membership does not survive a reconnect. Pending calls reject.

Rejoining is your code, not the library's (D4).

The hook you need:

```ts
let previous: ClientState['status'] = client.getSnapshot().status

const stopWatching = client.subscribe(() => {
  const { status } = client.getSnapshot()
  // The edge into `connected`, not the level. `subscribe` fires on every state change, and
  // several of those happen while the status is already `connected`, so comparing against
  // the previous status is what makes this run once per session.
  if (status === 'connected' && previous !== 'connected') void resubscribe()
  previous = status
})
```

`subscribe` returns its own unsubscribe, and dropping it leaks the listener for the lifetime
of the client. Call `stopWatching()` when the component or process that installed it goes
away.

[Reconnecting](/guides/reconnect/) has the whole recipe: authorising the rejoin, catching up
on what was missed, and the guard that stops two catch-ups overlapping.

## Scaling past one process

`MemoryAdapter` is the default and needs no infrastructure. For more than one server
process, implement the `Adapter` interface: frames cross it as bytes, never live objects,
and every method is async.

Test yours against `HostileAdapter` from `transport-io/testing`. It serialises through
bytes, adds latency, reorders, duplicates and fails on command.
