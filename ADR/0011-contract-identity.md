# ADR 0011 — Contract identity is an event table, not a fingerprint

**Status:** accepted · **Decision:** D53

## Decision

The handshake carries the **event table** — one `[name, id, lane]` triple per event — not a
hash of the contract. Peers compare tables **per event**, not as a whole.

| condition | outcome |
|---|---|
| Same name, different `lane` | **Refuse** the session, `WT_CONTRACT_MISMATCH`. |
| Same name, different `id` | **Refuse.** Genuine decoding disagreement. |
| Same `id`, different name | **Refuse.** Collision or override disagreement. |
| Name known to one peer only | **Proceed.** Clean per-message `WT_UNKNOWN_EVENT` if sent. |

**Payload schema shape is not included, at all.**

## The alternative rejected, and why it was nearly shipped

The draft specified SHA-256 over a canonical serialisation of the contract, truncated to 8
bytes, compared for equality. It was invented while writing prose and never had its
consequences worked through — which is exactly why it is dangerous.

A whole-contract hash is an **all-or-nothing** comparison. Any difference, anywhere,
refuses the session. That converts every additive contract change into a fleet-wide
cutover: a server that adds one event refuses every client still holding the previous
contract, even though the two agree perfectly about every event they share. For a chat
application, that is a mass disconnect on every deploy that touches the contract.

The per-event comparison catches strictly more of what matters and strictly less of what
does not.

## The principle

**Refuse what cannot be caught later; permit what can.**

That sentence decides every question this record answers, and it generalises past them.
A failure with a clean, local, per-message error does not belong in a handshake that
refuses whole sessions. A failure that corrupts silently and cannot be attributed does.
When a future question asks whether some new disagreement should be fatal at connect time,
this is the test to apply.

## Why payload schemas are excluded

Including them is the obvious implementation and it is wrong.

Adding an optional field to one event's payload is backwards compatible by every normal
definition. Under a schema-covering hash it refuses every existing session. The library
would be treating a compatible change as a breaking one, at the exact moment — a rolling
deploy — when that is most expensive.

The deeper reason is that **schema disagreement has a clean local failure mode and
identity disagreement does not.** A payload that does not match the receiver's schema
produces one `WT_VALIDATION_FAILED` on one message, scoped to that message, with a readable
error. A wrong event ID corrupts decoding for every message of that type, silently. The
handshake should refuse the failures that cannot be caught later and permit the ones that
can.

This is the same principle the lane decision rests on: surface the guarantee, not the
mechanism. Schema drift is an application-level mismatch and gets an application-level
error. Identity drift is a wire-level mismatch and gets a wire-level refusal.

## Why the table rather than a smarter hash

A per-event hash set would give the same comparison in fewer bytes. The table is chosen
anyway because it is **diagnosable**. On mismatch the peer can say

> event `cursor` is declared `datagram` here and `stream` by the peer

instead of

> contract hash mismatch

The size argument is weak: the handshake is a stream frame with a 1 MiB budget, sent once
per session. Fifty events cost roughly one kilobyte, once. Trading that for a diagnostic
that names the offending event is obviously correct, and it is the kind of trade a
compactness instinct gets wrong by default.

Note the interaction with ADR 0010: because IDs are name hashes, two peers computing an ID
for the same name always agree. The `id` column therefore only ever disagrees when someone
has set an explicit override on one side, which is precisely the rare, deliberate case
worth refusing over.

## Interaction with feature negotiation

Both live in the handshake and both can fail it, so the order and the severity are
specified rather than left to implementations:

1. **Event table is validated first, and conflicts are fatal.** A guarantee or decoding
   disagreement means no traffic is safe.
2. **`feat` is negotiated second, and is never fatal.** The active set is the intersection.
   An unrecognised token is ignored, not an error.

They are independent axes. A `feat` mismatch never refuses a session; an event conflict
always does. Nothing about a feature token can rescue a lane disagreement, and nothing
about a lane agreement implies a shared feature set.

## Consequence for D34

D34 stated the handshake's contents exhaustively as `{ v, feat }`. It ships three fields.
D34 is corrected to match, and the exhaustive claim is the reason this was caught — a
decision that enumerates should be checked against what the specification actually carries.

## Revisit when

A contract legitimately exceeds a few hundred events and the handshake table becomes a
measurable connection cost, or a user needs to run genuinely divergent contracts against
one server. The first is solved by a hash-with-table-fallback; the second is namespaces,
which are explicitly out of scope for v1.
