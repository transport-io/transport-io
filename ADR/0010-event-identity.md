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

## Width: four bytes, and why not two

The first draft used two bytes. Its collision table is the argument against it:

| width | 100 events | 200 events | 1000 events | header | datagram payload |
|---|---|---|---|---|---|
| 2 bytes | 7.27% | 26.19% | 99.95% | 11 | 1013 |
| 3 bytes | 0.03% | 0.12% | 2.93% | 12 | 1012 |
| **4 bytes** | **0.0001%** | **0.0005%** | **0.0116%** | **13** | **1011** |

At two bytes a collision is not a tail risk, it is a routine outcome: one contract in four
at 200 events.

What decided it is not the probability but **what a collision costs the person who hits
one.** They are told to rename an event in their own domain language because two SHA-256
prefixes happened to match — "rename `roomDeleted`, it collides with `userTyping`". No
error message makes that acceptable, and it lands in exactly the place this library is
meant to feel sharp.

Two bytes of a 1,013-byte payload budget is not a meaningful protection for an application.
A forced rename is a meaningful cost. Four bytes makes the collision a non-event for 0.2%
of the budget, and three bytes was rejected only because the remaining byte buys another
two orders of magnitude for nothing that matters.

The build-time collision error stays regardless. It should be unreachable rather than
absent, and an explicit `id` override remains available for anyone who contrives a
collision or needs a fixed value for an external implementer.

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
