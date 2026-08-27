# ADR 0008 - Backpressure: three lanes, three answers

**Status:** accepted · **Decision:** D15

## Decision

| lane | bound | on overflow |
|---|---|---|
| Datagram, per peer | 64 frames | Discard **oldest**, count it, never error. |
| Emit, per peer | 256 frames | Close the session with `WT_PEER_TOO_SLOW`. |
| Call stream | 16 frames high-water | Await the writer. Never discard. |

Plus a **150 ms time-to-live on queued datagrams, checked at dequeue**, counted separately
as `staleDropped` from `overflowDropped`.

## Alternative rejected

A single queueing policy for all outbound traffic, and awaiting each write inside the
broadcast loop.

Awaiting inside the loop lets one slow client stall an entire room. A single policy is
worse than useless because the three lanes make genuinely different promises: dropping is
correct on one, a lie on another, and unnecessary on the third.

## Why each answer differs

**Datagram - drop oldest.** Every realistic datagram payload is last-write-wins, so the
stale frames are the ones worth losing. 64 frames is roughly one second of buffer at 60 Hz.
Dropping is the lane's advertised contract, so it counts rather than throws.

**Emit - never drop, disconnect instead.** A lane that advertises reliable ordered delivery
and then silently drops is exactly the lie this project exists to avoid. A peer 256 frames
behind has already failed; disconnecting is the honest outcome.

**Call streams - no queue and no drop.** This one falls out of ADR 0002 rather than being
designed. Each call owns its own QUIC stream, so awaiting the writer applies flow control
to that call's own producer. One slow consumer stalls only itself. The requirement that one
slow consumer must not stall the others is satisfied by the transport, not by our queueing.

## Two axes, not one

Overflow and staleness are different problems and conflating them was the near-miss here.

Drop-oldest handles a burst. It does nothing for a peer that stalls for two seconds and
resumes: the ring never overflows, so 64 stale positions are dutifully delivered and the
application renders history. That is worse than delivering nothing, because it is wrong
rather than merely late.

TTL at dequeue fixes it. After a two-second stall, all but the newest few frames are past
150 ms and are discarded on the way out. 150 ms is chosen because pointer lag is
perceptible around 100 ms and reads as broken by 200 ms.

**The two counters matter more than the number.** `overflowDropped` and `staleDropped` let
an operator distinguish a slow consumer from a slow network. One number covering both would
be unactionable.

## The signal we do not have

The transport swallows its own "blocked" indication along with "too big", so a write that
was refused for congestion reports success. We therefore do not attempt to infer network
congestion, because we cannot. We bound our own queue and report our own drops, documented
as ours rather than the network's. Claiming to detect QUIC-level congestion would be a
fiction, and an unfalsifiable one.

## Revisit when

A 50-peer room at 60 Hz shows `(overflowDropped + staleDropped) / enqueued` above 1% for
any peer, measured over a 60-second window in the example app - or an emit-lane disconnect
is observed at a queue depth below 256.

The denominator is stated explicitly because a threshold expressed as a proportion of an
unmeasured quantity is unfalsifiable. Both terms here are counters this library owns.
