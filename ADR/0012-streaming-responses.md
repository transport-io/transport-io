# ADR 0012 - Streaming responses are async generators, with credit accounting

Status: accepted. Supersedes the "reserved, not implemented" note in ADR 0002 and D7.

## Context

An event could answer with one value. Agent and model workloads answer with a sequence, and
D7 reserved the wire shape for it in version 0: a response is a sequence of `CALL_RESPONSE`
frames terminated by stream close, and receivers were already required to accept any number.
So the wire was ready. The API was not.

## Decision

An **async iterable on the client, an async generator on the server**. Not a callback.

```ts
for await (const token of client.stream('ask', { prompt })) { render(token); if (stop) break }

server.handle('ask', async function* (payload, ctx) { for await (const t of model(payload)) yield t })
```

Three reasons, in the order they matter.

**`break` is the cancel.** Leaving the loop calls the iterator's `return()`, which resets the
QUIC stream, which surfaces as STOP_SENDING on the responder, which fires `ctx.signal` and
runs the generator's own `finally`. The headline feature costs no API surface at all. A
callback cannot express it: there is nothing to leave.

**Backpressure has somewhere to live.** The loop cannot advance until its body returns and
`yield` does not resume until the frame is accepted. A callback has nowhere to push back
from, which is how the emit backlog became an unbounded chain twice.

**Symmetry.** One side yields, the other consumes. Nothing new to learn on either end.

React is not a reason to add a callback. A hook is a callback that also manages state, and it
belongs in a binding package. Core ships the primitive.

### The lane is declared, and the reason is on the wire

`yields` goes in the contract next to `lane`, and cannot be chosen at the call site. The
argument is not symmetry with `lane`. It is that **a handler that yields nothing closes the
stream with zero `CALL_RESPONSE` frames, which is byte for byte what a broken `call()`
responder produces.** Identical bytes, two meanings: a protocol error in one shape and a
clean empty sequence in the other. Only the contract, exchanged at handshake, separates
them. A per-call-site choice leaves a second implementer with a case they cannot resolve.

### Credit accounting, because the transport lied

The design claim above was that flow control falls out of the language. **It was measured,
and on the reference binding it is false.**

A generator yielding as fast as it could, against a consumer sleeping 20 ms per element:

| element | consumer took | producer ran ahead | in flight |
|---|---|---|---|
| 16 B | 20 | 83,461 frames | ~2.2 MiB |
| 16 B | 40 | 136,523 frames | ~3.6 MiB |
| 1 KiB | 40 | 44,122 frames | ~44 MiB |
| 64 KiB | 40 | 839 frames | ~52 MiB |

Doubling what the consumer took doubled how far the producer got ahead, at every element
size. There is no plateau because `WritableStreamDefaultWriter.ready` resolves
unconditionally on the quiche binding: awaiting it applies no backpressure and the frames
accumulate in the transport. That is not a slow consumer being handled, it is an unbounded
buffer with a nicer API on top, and it would have shipped as "the language holds the bound".

D77's rule is that a bound is only a bound if something stays in the bounded thing. So the
accounting is ours: `CALL_CREDIT` (PROTOCOL.md §6.6). A responder starts with **32** frames
of credit, spends one per frame written, and waits at zero. The initiator grants credit for
elements the application has actually consumed, in batches of **16**. The same measurement
with the window in place is **33 frames, flat**, unchanged when the run doubles.

The cost is that a streaming initiator keeps its send side open, so it cannot FIN after the
request the way a `call()` initiator does. FIN from a streaming initiator therefore means
"no further credit is coming" and the responder treats it as cancellation, rather than
stalling for ever once the initial window is spent.

### What cancellation actually required

`writer.abort()` is not enough to interrupt a producer parked in `writer.write()`: per the
streams contract an abort request queues behind the write already in flight, so a generator
blocked writing to a consumer that has stopped reading stays blocked and its `finally` never
runs. The write is raced against the abort signal instead. The frame may still be in the
transport's hands afterwards, which is fine, because the stream is being torn down anyway.

This was found by a test, not by reading. It is the same shape as D69: the guarantee was
written down before anything checked it.

## Consequences

- No new frame type was needed for the response itself. `CALL_CREDIT` is new, and it is a
  frame the initiator sends, which no other message type does.
- `call()` is untouched. A 0.1.0 peer's `call()` still works against a 0.2.0 responder.
- The upstream 5.95 KB per-stream leak is now **amortised** rather than repeated: one
  generation of a thousand tokens costs 5.95 KB in total, where a thousand `call()`s cost
  5.95 KB each. For the workload this feature exists for, streaming is the cheaper shape.
- A stream occupies one of the 256 concurrent stream slots for its whole life rather than
  for a round trip. Ten concurrent generations for minutes is fine; the documentation now
  states the limit in those units.
- No `ReadableStream`. `tee()` and `pipeThrough()` imply buffering semantics that contradict
  the credit window. A `toReadable()` can be added if anyone asks for it.

## Revisit when

- A transport arrives whose `writer.ready` is honest. The credit window stays regardless:
  the responder is entitled to stop at zero and cannot know which transport it is on. But
  the window size becomes a tuning question rather than the only line of defence.
- Anyone measures a workload where 32 frames of credit is the wrong window. It is one
  constant in `protocol.ts` and one paragraph in the spec.
