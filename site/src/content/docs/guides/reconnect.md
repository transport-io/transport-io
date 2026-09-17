---
title: Reconnecting
description: A reconnect is a new session. Here is the recipe that puts a peer back where it was.
---

A reconnect is a new session. The peer gets a new id, a new origin, and no rooms: nothing
the server knew about the old session carries over, because the old session is gone and the
server cannot tell a returning client from a new one without asking.

This is deliberate (D4). What the library does not decide is what re-joining should cost.
That is your authorisation, your catch-up window and your idempotency. What follows is the
recipe. The library reconnects when asked and tells you when a session begins; the rest is
yours.

## The contract

Two callable events. One authorises and joins, one catches up on what was missed.

```ts
import {
  Client,
  type ClientOptions,
  defineContract,
  type MapOf,
  reliable,
  rpc,
  type Server,
  TransportError,
} from 'transport-io'

interface Message {
  readonly id: string
  readonly room: string
  readonly body: string
  readonly at: number
}

export const contract = defineContract({
  message: reliable<Message>(),
  resume: rpc<{ token: string; room: string }, { joined: boolean }>(),
  since: rpc<{ room: string; after: number }, { missed: readonly Message[] }>(),
})

export interface AppMap extends MapOf<typeof contract> {}

```

`resume` carries whatever your application uses to prove identity. `since` carries a
watermark and returns what the client missed while it was away.

## The server half

`ctx.peer` is the caller. `peer.id` is a value this server assigned itself and identifies
nobody, so `verify` below is the only check that means anything: authenticate the payload,
then act on the peer.

```ts
declare function verify(token: string): Promise<{ userId: string } | null>
declare function mayJoin(userId: string, room: string): Promise<boolean>
declare function history(room: string, after: number): Promise<readonly Message[]>

export function install(server: Server<AppMap>): void {
  server.handle('resume', async ({ token, room }, ctx) => {
    const who = await verify(token)
    if (who === null) {
      throw new TransportError('WT_HANDLER_ERROR', 'bad token', 'Sign in again.')
    }
    if (!(await mayJoin(who.userId, room))) return { joined: false }

    await ctx.peer.join(room)
    return { joined: true }
  })

  server.handle('since', async ({ room, after }, ctx) => {
    // Membership is the authorisation. A peer that has not joined cannot read the room's
    // history by asking for it, which is the failure this ordering exists to prevent.
    if (!ctx.peer.rooms.includes(room)) {
      throw new TransportError('WT_HANDLER_ERROR', 'not in room', 'Call resume first.')
    }
    return { missed: await history(room, after) }
  })
}
```

The order matters: `since` checks membership rather than the token, so `resume` has to come
first. Reversing them lets an unauthorised peer read history.

## Idempotency is yours

Both halves funnel into one function, so define it before the client. `since` and the live
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

Two things on the client. `reconnect` makes it come back on its own after a session drops,
with a wait that starts at `minMs`, doubles on each failed attempt up to `maxMs`, and is
randomised between half of that and all of it. `onSession` runs once for every session the
client gets, the first and each one a reconnect produces, which is where the catch-up goes.

```ts
declare const connect: ClientOptions['connect']

export const client = new Client<AppMap>({
  contract,
  connect,
  reconnect: { minMs: 500, maxMs: 30_000 },
})

export function keepUp(token: string, room: string): () => void {
  const stop = client.onSession(async () => {
    const { joined } = await client.call('resume', { token, room })
    if (!joined) return
    const { missed } = await client.call('since', { room, after: watermark })
    for (const m of missed) apply(m)
  })
  client.on('message', (m) => apply(m))
  return stop
}
```

`onSession` runs once per session, never once per state change, and a session that drops
during the catch-up is a new session with its own run: the earlier run's calls reject with
`WT_SESSION_CLOSED`, since they were on the session that is gone.

**The watermark advances inside `apply`, from live messages as well as caught-up ones.**
Between `resume` returning and `since` returning, live messages arrive on the emit stream.
Advancing in one place means the next catch-up asks for the right window rather than
replaying what already arrived.

The first `connect()` is not retried: it resolves or rejects as it always did, and the
retrying starts once a session has been had. `disconnect()` stops a reconnect that is
waiting. With no `reconnect` given, a dropped session stays closed and the snapshot says so.

A refusal stops it as well. When the server's [`authorize`](/guides/authorize/) refuses a
reconnect, the snapshot has `refused: { reason }` beside `closed`, and nothing is retried:
the same request would be refused again. Show the sign-in, and once there is a credential
that will pass, `disconnect()` and `connect()`.

## What this does not do

It does not survive a server restart, because `history` is your storage and the recipe says
nothing about what that is. It does not handle a token that expires mid-session: `resume`
returns `joined: false` and the client is left connected but out of the room, which is the
right shape, and what to do about it is a product decision. With [`authorize`](/guides/authorize/)
at the door, an expired token is refused on the next connect instead, and `refused` says so.

It does not keep a transport. A reconnect starts from WebTransport every time, so it may
land on [the fallback](/guides/fallback/) or come back off it, and `transport` in the
snapshot says which carried this session.
