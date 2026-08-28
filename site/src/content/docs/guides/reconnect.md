---
title: Reconnecting
description: A reconnect is a new session. Here is the recipe that puts a peer back where it was.
---

A reconnect is a new session. The peer gets a new id, a new origin, and no rooms: nothing
the server knew about the old session carries over, because the old session is gone and the
server cannot tell a returning client from a new one without asking.

This is deliberate (D4). Silent re-join is a security decision wearing a convenience
costume: it means the server re-grants access it granted once, to a peer it has not
re-authorised, on the strength of a claim the client makes about itself.

What the library does not decide is what re-joining should cost. That is your
authorisation, your catch-up window and your idempotency. What follows is the recipe. Copy
it.

## Why this is events and not `call()`

The obvious shape is an `rpc` that authorises and joins, and it does not work today. A call
handler is registered on the server rather than on a peer, and the `ctx` it receives is
`{ signal }` and nothing else: there is no `ctx.peer`.

There is no way for a call handler to learn who called it, so it cannot join the caller to a
room. Taking a peer id in the payload does not fix it, because the server cannot verify the
client sent its own.

Per-peer handlers do have the peer, and they are event handlers: `peer.on(...)` inside
`onSession`. So the recipe below is a pair of events in each direction, which is
request-and-response written out by hand. It works, and the shape is a known cost rather
than a preference.

## The contract

```ts
import {
  type Client,
  type ClientState,
  defineContract,
  type MapOf,
  reliable,
  type Server,
} from 'transport-io'

interface Message {
  readonly id: string
  readonly room: string
  readonly body: string
  readonly at: number
}

export const contract = defineContract({
  message: reliable<Message>(),
  resume: reliable<{ token: string; room: string }>(),
  resumed: reliable<{ room: string; joined: boolean }>(),
  catchUp: reliable<{ room: string; after: number }>(),
  missed: reliable<{ room: string; messages: readonly Message[] }>(),
})

export interface AppMap extends MapOf<typeof contract> {}

declare module 'transport-io' {
  interface Register {
    map: AppMap
  }
}
```

`resume` carries whatever your application uses to prove identity. `catchUp` carries a
watermark, and `missed` returns what the client did not see while it was away.

## The server half

`peer.on` is where identity enters the system. The library has not identified anyone for
you: `peer.id` is a value the server assigned itself, so `verify` below is the only check
that means anything.

```ts
declare function verify(token: string): Promise<{ userId: string } | null>
declare function mayJoin(userId: string, room: string): Promise<boolean>
declare function history(room: string, after: number): Promise<readonly Message[]>

export function install(server: Server): void {
  server.onSession((peer) => {
    // `peer.on` takes a synchronous handler, so async work is started rather than awaited.
    peer.on('resume', ({ token, room }) => {
      void (async () => {
        const who = await verify(token)
        const ok = who !== null && (await mayJoin(who.userId, room))
        if (ok) await peer.join(room)
        peer.emit('resumed', { room, joined: ok })
      })()
    })

    peer.on('catchUp', ({ room, after }) => {
      void (async () => {
        // Membership is the authorisation. A peer that has not joined cannot read a room's
        // history by asking for it, which is the failure this ordering exists to prevent.
        if (!peer.rooms.includes(room)) return
        peer.emit('missed', { room, messages: await history(room, after) })
      })()
    })
  })
}
```

The order matters: `catchUp` checks membership rather than the token, so a client that has
not completed `resume` gets nothing. Reversing them lets an unauthorised peer read history.

## Idempotency is yours

Both halves funnel into one function, so define it before the client. `missed` and the live
stream overlap: a message can arrive both ways, and every message carries an `id` for
exactly that reason.

```ts
const seen = new Set<string>()
let watermark = 0

function apply(m: Message): void {
  if (seen.has(m.id)) return
  seen.add(m.id)
  if (m.at > watermark) watermark = m.at
  render(m)
}

declare function render(m: Message): void
```

Comparing timestamps instead of ids would be wrong the first time two messages share a
millisecond. An id is cheaper than being careful.

## The client half

`subscribe` and `getSnapshot` are the two methods a React binding hands to
`useSyncExternalStore`, and they are enough on their own. Watch for the transition into
`connected` and start there.

```ts
export function keepUp(client: Client, token: string, room: string): () => void {
  let previous: ClientState['status'] = client.getSnapshot().status

  const unsubscribe = client.subscribe(() => {
    const { status } = client.getSnapshot()
    // The edge into `connected`, not the level: `subscribe` fires on every state change,
    // and several of those happen while the status is already `connected`.
    if (status === 'connected' && previous !== 'connected') {
      client.emit('resume', { token, room })
    }
    previous = status
  })

  client.on('resumed', ({ room: r, joined }) => {
    if (joined) client.emit('catchUp', { room: r, after: watermark })
  })

  client.on('missed', ({ messages }) => {
    for (const m of messages) apply(m)
  })

  client.on('message', (m) => apply(m))

  return unsubscribe
}
```

Two things in there are not obvious, and each one is a bug if you leave it out.

**The edge, not the level.** Comparing against the previous status makes this run once per
session rather than once per notification.

**The watermark advances inside `apply`, from live messages as well as caught-up ones.**
Between `resume` and `missed` arriving, live messages come in on the emit stream. Advancing
in one place means the next catch-up asks for the right window rather than replaying what
already arrived.

## What this does not do

It does not survive a server restart, because `history` is your storage and the recipe says
nothing about what that is. It does not handle a token that expires mid-session: `resumed`
arrives with `joined: false` and the client is left connected but out of the room, which is
the right shape, and what to do about it is a product decision.

It does not retry. `client.connect()` is idempotent and refcounted, so a retry loop around
it is safe to write, and the library does not write one for you: how long to back off and
when to stop are the parts every application answers differently.
