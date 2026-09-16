---
title: The two lanes
description: What reliable and unreliable promise, and how to choose between them.
---

Every event declares a lane. The lane names a guarantee.

| lane | promise | carried on |
|---|---|---|
| `reliable` | It arrives, in order, or the session fails. | QUIC streams |
| `unreliable` | It may be dropped, duplicated or reordered. | QUIC datagrams |

## Choosing a lane

If losing the message would be a bug, use `reliable`. Chat messages, state changes,
acknowledgements.

If the next value makes the previous one irrelevant, use `unreliable`. Cursor positions,
presence heartbeats, volume levels, progress percentages.

The question is whether a message is superseded, not whether it is important. A cursor
position matters, and it still belongs on the unreliable lane: a dropped one is replaced 16
milliseconds later.

## The unreliable lane

Nothing on this lane is guaranteed. There is no delivery guarantee, no ordering, no
acknowledgement, no retransmission and no flow-control feedback. Loss is not reported.

Two things are handled for you:

- **Duplicates are discarded.** A datagram that arrives twice is delivered once.
- **Stale arrivals are dropped rather than rendered.** A queued datagram older than 150 ms
  is discarded on the way out, so a peer that stalls and resumes does not animate a backlog.

There is a size ceiling, and it is a property of the network path rather than a constant.
Query it at send time; the library does, and an oversized payload is refused rather than
silently swallowed.

## The reliable lane

It never drops. A peer that falls 256 frames behind has its session closed with
`WT_PEER_TOO_SLOW`.

One thing to know: all rooms share one emit stream per direction, so a high-volume room
delays a quiet room's messages to the same peer. Calls and streams are isolated from each
other and from emits. Emits are not isolated from each other.

## The lane is per event, not per call

Reliability is declared once, in the contract, and cannot be set at a call site. `returns`
and `yields` are valid only on `reliable`, since an unreliable event has no response path.

## Direction is per event too

Most events travel both ways under one name. One that only one side sends can say so:

```ts
import { defineContract, fromClient, fromServer, reliable, unreliable } from 'transport-io'

export const directed = defineContract({
  chat: reliable<{ from: string; body: string }>(),
  users: fromServer(reliable<{ names: readonly string[] }>()),
  cursor: fromClient(unreliable<{ x: number; y: number }>()),
})
```

The client's `emit` then refuses `users` and its `on` refuses `cursor`; the server's `emit`
and broadcasts refuse `cursor`, and a peer that sends the wrong way anyway is dropped and
counted in `stats().directionDropped`. A call or a stream takes no direction. An event both
sides send is still one payload shape for both directions.
