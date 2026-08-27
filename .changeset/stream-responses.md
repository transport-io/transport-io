---
'transport-io': minor
---

`stream()`: an event declaring `yields` instead of `returns` answers with a sequence. The
client gets an async iterable with a `collect()`, the server writes an async generator.
Leaving the loop with `break` resets the QUIC stream, which fires the handler's `ctx.signal`
and runs its `finally`, so cancellation costs no extra API.

Adds one frame type, `CALL_CREDIT`. A streaming responder may run at most 32 frames ahead of
what the consumer has taken, because the transport's own flow control turned out to apply
none: measured on the reference binding, a producer ran 136,523 frames and roughly 53 MB
ahead of a consumer that had taken 40. A streaming initiator therefore keeps its send side
open rather than half-closing after the request.

`call()` is unchanged and a 0.1.0 caller still works against a 0.2.0 responder. See ADR 0012
and D93.
