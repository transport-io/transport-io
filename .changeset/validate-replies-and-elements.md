---
'transport-io': minor
---

A call's reply and a stream's elements are now validated against the contract's `returns` and
`yields` schemas when they arrive on the side that called, as every other inbound payload
already was, and `validateInbound: false` turns this off with the rest. A reply that fails its
schema rejects `call()` with `WT_VALIDATION_FAILED`. An element that fails its schema throws
`WT_VALIDATION_FAILED` from the loop, after the elements before it, and resets the stream, so
the responder's `ctx.signal` fires and its generator's `finally` runs. Types-only slots and
`bytes()` slots behave as before.

**Breaking:** a reply or an element that does not match its schema resolved before and rejects
now. A schema that transforms its input hands the caller the transformed value.
