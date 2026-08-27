# ADR 0009 - One emit stream per direction, handshake as frame 0

**Status:** accepted · **Decision:** D32, D33

## Decision

Each peer opens **exactly one unidirectional stream** for its entire stream-lane output and
frames all emits onto it. The handshake is **frame 0** of that stream.

## Alternative rejected: one stream per emit

Per-emit streams would give every message full independence, matching what calls get.

Rejected because it multiplies stream churn by message volume, and stream churn is the
known upstream memory-growth path - the same risk that made a soak test a graduation
criterion in ADR 0002. A busy chat room would turn a manageable leak into a fast one. It
also adds stream-identifier accounting per message for a lane whose useful guarantee is
ordering, not isolation.

## The cost, stated plainly

**Head-of-line blocking on the emit lane is cross-room.** All rooms share one stream per
direction, so a high-volume room delays a quiet room's messages to the same peer.

This is the problem this transport is marketed as solving, reintroduced on the lane most
applications will use most. It is a real cost, not a technicality, and it is documented in
three places - this record, the protocol specification, and the README - so that
"independent streams" is never read as a promise about emits.

The trade is still right: calls and datagrams remain fully isolated, and the alternative
trades a bounded latency cost for an unbounded memory one.

### The second cost, found by audit

One shared lane means one unrecoverable failure. A protocol error on a per-emit stream
would cost one message; on the shared lane it destroys **all** stream-lane traffic for the
session, because there is no second stream and no way to reopen this one.

The specification therefore escalates: any protocol error on the emit stream closes the
session rather than resetting the stream. That is the correct fix, but it should be read as
what it is - a second consequence of the same trade, surfacing on its own after the
decision was made. Head-of-line blocking was the cost we accepted knowingly. This one we
did not see, and it is the more serious of the two: a single malformed frame now ends the
session instead of one message.

Both costs come from the same source. A third would be a reason to revisit the trade, not
merely to patch the symptom.

Per-room emit lanes are reserved as the `emit-per-room` feature token. Reserving costs
nothing and means a chatty room becomes a negotiation rather than a redesign.

## Handshake as frame 0

A dedicated handshake stream would need a rule rejecting any traffic that arrives before
the handshake, because QUIC provides no ordering *between* streams. That rule guards a
race.

Putting the handshake at frame 0 of the emit stream removes the race instead. In-order
delivery within a stream makes early stream-lane traffic impossible by construction, and
the `WT_HANDSHAKE_INCOMPLETE` session-close rule disappears.

Two residual cases exist, and both resolve into behaviour that already had to exist:

- **A datagram may still arrive first.** It is discarded silently, which is the unreliable
  lane's contract. No new rule.
- **A call stream may still race.** The server answers on that stream with a call-error
  frame and resets it, reusing the existing error path. No session close.

The cost accepted is that a version mismatch is refused after allocating a stream reader
rather than before. One reader, in exchange for removing a race from the protocol.

**The 5000 ms handshake deadline earns its place separately.** A peer that never opens its
emit stream is indistinguishable from one that opens it and never writes - which is exactly
the observed behaviour of the browser described in ADR 0003, where the session establishes
and then no application bytes ever flow. The deadline turns that silent hang into
`WT_HANDSHAKE_TIMEOUT` with a message naming the likely cause.

## Revisit when

p99 emit delivery latency to a peer in a quiet room exceeds 100 ms while a room that peer
also belongs to sustains more than 200 emits per second. That is the point at which
`emit-per-room` stops being reserved and starts being implemented.
