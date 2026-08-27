---
title: The two lanes
description: What reliable and unreliable actually promise, and how to choose.
---

Every event declares a lane, and the lane names a **guarantee**, not a mechanism.

| lane | promise | carried on |
|---|---|---|
| `reliable` | It arrives, in order, or the session fails. | QUIC streams |
| `unreliable` | It may be dropped, duplicated or reordered. | QUIC datagrams |

The names were `stream` and `datagram` until 0.2.0. They were renamed because those words
describe the machinery, and the whole position of this library is that machinery is hidden
and guarantees are exposed. The lane was the one place saying otherwise.

## Choosing

Ask one question: **if this message vanished, would you want to know?**

If yes, it is `reliable`. A chat message, a state change, an acknowledgement, anything a
human would notice missing.

If no, it is `unreliable`. A cursor position, a presence heartbeat, a volume level, a
progress percentage. Anything where the next value makes the previous one irrelevant.

The test is not "is it important". It is "is it superseded". A cursor position is important
and still belongs on the unreliable lane, because a dropped one is corrected 16 milliseconds
later by the next.

## What the unreliable lane really does

Nothing on this lane is guaranteed. No delivery, no ordering, no acknowledgement, no
retransmission, no flow-control feedback. Loss is reported to nobody, because loss is the
contract.

Two things are done for you, and both are about correctness rather than delivery:

- **Duplicates are discarded.** A datagram that arrives twice is delivered once.
- **Stale arrivals are dropped rather than rendered.** A queued datagram older than 150 ms
  is discarded on the way out. Without that, a peer that stalls for two seconds and resumes
  receives a backlog of old positions and animates history, which is worse than receiving
  nothing.

There is a size ceiling, and it is a property of the network path rather than a constant.
Query it at send time; the library does, and an oversized payload is refused rather than
silently swallowed.

## What the reliable lane really does

It never drops. If a peer falls 256 frames behind, the session is closed with
`WT_PEER_TOO_SLOW` rather than discarding anything, because a lane that advertises reliable
delivery and then drops silently is the lie this project exists to avoid.

One caveat that is easy to miss: **all rooms share one emit stream per direction**, so a
high-volume room delays a quiet room's messages to the same peer. Calls and streams are
fully isolated from each other and from this. Emits are not.

## Why not one lane with a flag

Because the guarantee belongs to the message type, not the call site. If reliability were an
argument to `emit()`, two calls sending the same event could disagree, and a reader of the
contract could not tell what the data promises without reading every call site. Putting it
in the contract means one place to look and no way to be inconsistent.

It also means the type system enforces it: `returns` and `yields` are valid only on
`reliable`, because an unreliable event has no response path.
