# ADR 0004 - Reconnect creates a new session

**Status:** accepted · **Decision:** D4

## Decision

A reconnection is a new session with a new identity. Room membership does not survive it.
Pending calls reject with `WT_SESSION_CLOSED`. The `session` event carries
`{ id, resumed }` and `resumed` is always `false`.

Re-establishing authentication and resubscribing to rooms is the application's job. This
library provides the primitive and the hook.

## Alternative rejected

Transparent resumption: buffer outbound messages across the gap, restore room membership
automatically, and resolve pending calls once reconnected.

Transparent resumption is a correctness claim the transport cannot honestly make. Whether a
call was executed before the connection dropped is unknowable from the client, so
"resuming" it means either silently risking duplicate execution or silently dropping it.
Restoring room membership without re-authenticating means a session's authorization
outlives the connection it was granted on.

## Why this way

The failure is visible, which is the point. An application that must survive reconnection
writes that logic explicitly, with its own idempotency and its own re-auth, rather than
inheriting a guarantee that quietly does not hold.

Shipping the `resumed` field now, hardcoded `false`, means genuine resumption can arrive as
a negotiated feature token rather than a change in the shape of the session event.

## Revisit when

The `session-resume` feature token is implemented. At that point `resumed` becomes
meaningful and the negotiation already has a place to live.
