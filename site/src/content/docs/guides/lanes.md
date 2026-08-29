---
title: The two lanes
description: What reliable and unreliable promise, and how to choose between them.
---

Every event declares a lane. The lane names a guarantee.

| lane | promise | carried on |
|---|---|---|
| `reliable` | It arrives, in order, or the session fails. | QUIC streams |
| `unreliable` | It may be dropped, duplicated or reordered. | QUIC datagrams |

A lane names the guarantee your data gets, not the mechanism that carries it. That is the
whole reason the values read the way they do.

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
  is discarded on the way out. Without that, a peer that stalls for two seconds and resumes
  receives a backlog of old positions and animates history, which is worse than receiving
  nothing.

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

Reliability is declared once, in the contract. If it were an argument to `emit()`, two call
sites sending the same event could disagree, and reading the contract would not tell you
what the data promises.

The types follow from it: `returns` and `yields` are valid only on `reliable`, since an
unreliable event has no response path.
