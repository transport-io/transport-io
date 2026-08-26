# ADR 0010 — Event IDs are name hashes, not positions

**Status:** accepted · **Decision:** D52

## Decision

An event's wire identifier is the **first two bytes of SHA-256 of its name**, big-endian,
as a `u16`. It is not derived from position in the contract, in declaration order or in
sorted order.

Collisions are detected when the contract is built and are a **hard error** naming both
events, resolved by an explicit `id` on one of them. An explicit `id` is part of the
contract and therefore shared by both peers.

## Alternative rejected: positional indices

The original draft assigned the 1-based index of the event in the contract sorted by name.
It is more compact to describe and identical in size on the wire.

It fails on the only axis that matters, which is what happens when a contract changes.
**Positional means insertion renumbers.** Adding an event named `archive` to a contract
containing `chat` and `cursor` shifts both of them by one. Every peer holding the previous
contract now disagrees with the new one about what `1` means — not for the new event, but
for events nobody touched.

The consequence in operation is severe and non-obvious: during a rolling deploy, adding a
single event silently redefines the meaning of every existing event ID, and the two halves
of the fleet decode each other's traffic incorrectly rather than failing cleanly. A
contract change becomes a hard cutover requiring every client to reload simultaneously.
For the chat application this library targets, that is a mass disconnect on every deploy
that touches the contract.

## Why a name hash fixes it

Name-derived identity has a property positional identity cannot have: **it is a pure
function of the name.** Two peers computing an ID for the same name always agree, whether
or not they agree on anything else in the contract. Adding, removing or reordering events
changes no existing identifier.

That property is what makes rolling deploys work, and it is also what makes the contract
identity check in ADR 0011 cheap — most of the disagreement it would otherwise have to
detect cannot arise.

## The collision cost, quantified

A 16-bit space collides by the birthday bound. Approximate probability that some pair of
`n` event names collides:

| events | collision probability |
|---|---|
| 20 | ~0.3% |
| 50 | ~1.9% |
| 100 | ~7.3% |
| 200 | ~26% |

For the contract sizes this library targets, collisions are uncommon; at 200 events they
are likely. This is acceptable **only because the failure is loud and early**: it is
detected when the contract is constructed, not at runtime, and the message names both
colliding events and the one-line fix. A silent 7% failure rate would not be acceptable; a
build error that says what to do is.

Widening to `u32` would drop the probability to negligible at a cost of two more bytes per
datagram, which is roughly 0.2% of a 1017-byte payload budget. That is the obvious
revisit, and it is deliberately not taken now: two bytes is two bytes on the lane whose
entire justification is being small, and the build-time error is a real mitigation rather
than a hope.

## Deploy story, stated as a property rather than discovered

- **Adding an event** changes no existing identifier. Rolling-deploy safe.
- **Removing an event** changes no existing identifier. Peers that still send it receive a
  clean per-message `WT_UNKNOWN_EVENT`.
- **Renaming an event** is a remove plus an add. The old name stops being understood.
- **Changing an event's lane** is breaking, and is refused at the handshake by ADR 0011.
  It changes a guarantee the application depends on.
- **Changing an explicit `id`** is breaking and is refused, because it is a genuine
  decoding disagreement.

The README states this as a property of the library, in these terms, rather than leaving it
to be discovered in production.

## Revisit when

A real contract exceeds roughly 100 events, or a collision report arrives from a user whose
names cannot reasonably be changed. The fix is `u32` identifiers behind a `feat` token, and
the datagram header budget already has room for it.
