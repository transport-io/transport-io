# ADR 0005 — The adapter boundary, and why it has a hostile implementor

**Status:** accepted · **Decision:** D5, D20, D22, D40, D44

## Decision

Fan-out crosses a four-method interface. `MemoryAdapter` ships in core and is the default,
so installation requires no infrastructure. Redis is not in v1 and core never references
it in any form.

The interface is the v1 deliverable, not a second implementation of it.

## Alternative rejected

Shipping a Redis adapter in v1 to prove the boundary, or deferring the boundary until a
second backend exists.

Shipping Redis makes infrastructure a precondition for trying the library and pulls a
dependency into core's tree that most users never need. Deferring the boundary means
retrofitting one later around code that assumed a single process.

## The real risk, and the answer

**An interface with one implementor is usually wrong, and `MemoryAdapter` is a misleading
sole implementor.** It is effectively synchronous, never fails, passes live object
references and always knows a room's full membership. None of that holds for a real bus,
so core could satisfy `MemoryAdapter` perfectly and still be unshippable on Redis.

`HostileAdapter` exists in tests to close that gap without a network or a broker. It
serialises every frame to bytes and back, adds artificial latency, delivers the publisher
its own messages, reorders deliveries, and fails on command. The conformance suite runs
against both.

The rules that fall out, which core obeys from day one:

- Every adapter method is async, even in memory.
- `PeerId` is a stable cross-process string, never an object reference.
- Frames cross as bytes, never live objects.
- Core must not assume the local node knows a room's full membership.
- A frame for a room with no local members is dropped silently, not an error.
- A node receiving its own publish back is normal. Core dedupes by origin node id, and
  local peers are delivered directly rather than via a bus round-trip.
- Any method may reject. Core degrades rather than crashing.
- Nothing in core assumes a single shared process, and room membership never lives in a
  module-level map in core.

## Consequence accepted

Local peers observe a message slightly before remote peers, because local delivery does
not wait for the bus. That is inherent to any fan-out and is documented rather than hidden.

## Revisit when

The Redis adapter is built. If core needs changes to accommodate it, `HostileAdapter` was
not hostile enough, and the gap it missed is the thing to add.
