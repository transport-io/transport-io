# ADR 0001 - The lane lives in the contract

**Status:** accepted · **Decision:** D1

## Decision

Every event declares `lane: 'stream' | 'datagram'` where the event itself is declared. The
lane is never chosen at the call site, and there is no per-call override.

## Alternative rejected

A lane argument on `emit`, as in `emit('cursor', data, { lane: 'datagram' })`.

That makes reliability a property of an individual send rather than of the data. Two call
sites for the same event can then disagree, and the disagreement is invisible until
production, when one path silently starts dropping. It also puts the guarantee out of
reach of the type system: nothing can check that every `cursor` send made the same choice.

## Why this way

Reliability semantics are a property of the application's data. "This message may be
dropped" is a design statement about `cursor`, not an implementation detail of one send.
Putting it in the contract means client and server infer the same guarantee from the same
declaration and cannot disagree about it.

It also makes the contract file genuinely complete: reading it tells you every event, its
payload and its delivery guarantee, with nothing left to discover at call sites.

## Revisit when

An application demonstrates a real event whose correct lane depends on runtime state
rather than on the data's nature. A lane override would then be an event-level option with
both lanes declared, not a free-form call-site argument.
