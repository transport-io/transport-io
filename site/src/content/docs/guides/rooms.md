---
title: Rooms
description: Server-authoritative membership, and what a reconnect does to it.
---

A room is a name. Peers join it, the server broadcasts to it, and nothing else about it is
persistent.

```ts
import { createServer, defineContract, type MapOf, TransportError, type$ } from 'transport-io'

const contract = defineContract({
  chat: { lane: 'reliable', payload: type$<{ body: string }>() },
  cursor: { lane: 'unreliable', payload: type$<{ x: number; y: number }>() },
  subscribe: {
    lane: 'reliable',
    payload: type$<{ room: string }>(),
    returns: type$<{ joined: boolean }>(),
  },
})
interface AppMap extends MapOf<typeof contract> {}

declare const server: ReturnType<typeof createServer<AppMap>>
declare const client: import('transport-io').Client<AppMap>
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

This is not an oversight. Room membership is an authorisation decision, and the only place
that can make it is the side that knows who the peer is. An application that wants
client-initiated subscription implements it as a `call()`, which is already the path where
you can check something before saying yes:

```ts
server.onSession((peer) => {
  server.handle('subscribe', async ({ room }) => {
    if (!allowed(room)) {
      throw new TransportError('WT_ROOM_NOT_JOINED', 'not yours', 'Ask an admin.')
    }
    await peer.join(room)
    return { joined: true }
  })
})
```

Clients still learn their own membership: the server sends `JOIN` and `LEAVE` frames so
`client.getSnapshot().rooms` stays accurate. Those frames report a decision, they do not
request one.

## Broadcasting

```ts
declare const msg: { body: string }
declare const pos: { x: number; y: number }
declare const peer: { id: string }

server.to('lobby').emit('chat', msg)                    // everyone in the room
server.to('lobby').except(peer.id).emit('cursor', pos)  // everyone but the sender
```

`except` matters more than it looks on the unreliable lane. You already know where your own
pointer is, so echoing it back is pure waste on a lane where every frame competes with a
fresher one.

## A reconnect is a new session

**Room membership does not survive a reconnect.** Neither do pending calls, which reject.

This is deliberate and it is the one piece of lifecycle you have to write yourself. The
alternative is a library that silently re-joins rooms on your behalf, and it cannot know
whether that is safe: whether the authorisation still holds, whether a call it retried was
already executed on the far side. Whether a request completed before the connection dropped
is unknowable from the client, and pretending otherwise means silently risking duplicate
execution.

So the primitive and the hook are yours:

```ts
client.subscribe(() => {
  const { status } = client.getSnapshot()
  if (status === 'connected') void resubscribe()
})
```

## Scaling past one process

`MemoryAdapter` is the default and needs no infrastructure. For more than one server
process, implement the `Adapter` interface: frames cross it as bytes, never live objects,
and every method is async.

Test yours against `HostileAdapter` from `transport-io/testing`, which serialises through
bytes, adds latency, reorders, duplicates and fails on command. An adapter that only passes
against an in-memory map has not been tested against anything.
