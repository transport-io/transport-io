---
title: Reconnecting
description: A reconnect is a new session. Here is the recipe that puts a peer back where it was.
---

A reconnect is a new session. The peer gets a new id, a new origin, and no rooms: nothing
the server knew about the old session carries over, because the old session is gone and the
server cannot tell a returning client from a new one without asking.

This is deliberate (D4). What the library does not decide is what re-joining should cost. That is your
authorisation, your catch-up window and your idempotency. What follows is the recipe. Copy
it.

## The contract

Two callable events. One authorises and joins, one catches up on what was missed.

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

`subscribe` and `getSnapshot` are the two methods a React binding hands to
`useSyncExternalStore`, and they are enough on their own. Watch for the transition into
`connected` and do the work there.

```ts
export function keepUp(client: Client<AppMap>, token: string, room: string): () => void {
  let previous: ClientState['status'] = client.getSnapshot().status
  let inFlight: Promise<void> | null = null

  const catchUp = async (): Promise<void> => {
    const { joined } = await client.call('resume', { token, room })
    if (!joined) return
    const { missed } = await client.call('since', { room, after: watermark })
    for (const m of missed) apply(m)
  }

  const unsubscribe = client.subscribe(() => {
    const { status } = client.getSnapshot()
    const arrived = status === 'connected' && previous !== 'connected'
    previous = status
    if (arrived && inFlight === null) {
      inFlight = catchUp()
        .catch(() => undefined)
        .finally(() => {
          inFlight = null
        })
    }
  })

  client.on('message', (m) => apply(m))

  return unsubscribe
}
```

Three things in there are not obvious, and each one is a bug if you leave it out.

**The edge, not the level.** `subscribe` fires on every state change, and several of them
happen while `status` is already `connected`. Comparing against the previous status makes
this run once per session rather than once per notification.

**The guard.** A connection that drops during catch-up fires `connected` again while the
first catch-up is still awaiting. Without `inFlight`, the two interleave and the watermark
moves backwards.

**The watermark advances inside `apply`, from live messages as well as caught-up ones.**
Between `resume` returning and `since` returning, live messages arrive on the emit stream.
Advancing in one place means the next catch-up asks for the right window rather than
replaying what already arrived.

## What this does not do

It does not survive a server restart, because `history` is your storage and the recipe says
nothing about what that is. It does not handle a token that expires mid-session: `resume`
returns `joined: false` and the client is left connected but out of the room, which is the
right shape, and what to do about it is a product decision.

It does not retry. `client.connect()` is idempotent and refcounted, so a retry loop around
it is safe to write, and the library does not write one for you.
