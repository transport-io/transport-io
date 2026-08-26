# ADR 0007 — An internal transport seam with one implementation

**Status:** accepted · **Decision:** D21

## Decision

One internal `Transport` interface with a single implementation. It is **not** a public
plugin API and is not exported in v1.

## Alternative rejected

Calling the transport package directly from session logic.

That spreads a dependency with several known defects across the codebase. Every workaround
becomes a scattered special case instead of a contained one.

## Why a seam with one implementor is justified here

Ordinarily a boundary with one implementor is a smell — the same argument made against
`MemoryAdapter` in ADR 0005. Two things make this the exception:

1. **Two credible second implementors now exist**: a Rust-backed NAPI binding over quinn,
   and a runtime with native QUIC support behind a flag. Neither is adopted, but neither is
   hypothetical.
2. **The current dependency has defects that must not leak.** It silently swallows
   oversized and blocked datagrams; its error type omits the specification's
   `streamErrorCode` so reset codes are recoverable only by parsing a message string; it
   ships a reliability fallback that must be actively disabled. Quarantining these behind
   one interface is worth a file.

The cost is one file. The benefit is that replacing the transport is a contained change
rather than an archaeology exercise.

## Recorded constraint

**The dominant browser implements neither `sendOrder` nor `createSendGroup`.** Stream
prioritisation is therefore unavailable there, and must not be designed into the protocol
on the assumption that the primitive exists. This is recorded here specifically so a later
design for prioritising one response stream over another does not start from a false
premise.

## Revisit when

A second transport is actually adopted. At that point the interface either fits or reveals
what it got wrong, and only then is there a reason to consider making it public.
