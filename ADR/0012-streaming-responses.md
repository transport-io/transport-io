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

**`next()` is the credit signal.** Consuming an element is the event that refills the
window, and an iterator has exactly one such event, in exactly the right place: the consumer
asking for the next value. A callback has no equivalent. The producer fires and nothing ever
says the consumer kept up, so a callback API has to buffer, and a buffer is the thing this
design exists to avoid.

> **A falsified reason, recorded rather than replaced.** The original justification for this
> point was "backpressure falls out of the language": the loop cannot advance until its body
> returns, and `yield` does not resume until the frame is accepted, so nothing accumulates.
> **That was measured and found false.** `writer.ready` resolves unconditionally on the
> reference binding, so awaiting the write accepts nothing and holds nothing back; the
> numbers are below. The async iterable is still the right shape, but because it *provides
> the signal a credit scheme needs*, not because the language enforces anything. A future
> session reading the original sentence would build on something already disproved, which is
> why it is struck here instead of quietly rewritten.

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

This is the measurement that falsified the original second reason.

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

### Why 32 and 16

Chosen, then validated. The sweep, on the reference binding with 59-byte frames, consumer
never waiting for the rate column:

| window | refill | bound | elements/second |
|---|---|---|---|
| 4 | 2 | 5 | 19,597 |
| 8 | 4 | 9 | 28,611 |
| 16 | 8 | 17 | 26,449 |
| **32** | **16** | **33** | **27,470** |
| 128 | 64 | 129 | 35,272 |
| none | - | 77,273 then 127,998, growing | 67,616 |

The bound is always window + 1, which is the scheme working. The rate is the interesting
column: 4 costs about 29%, and 8 through 32 are within noise of each other. 128 buys 28% for
four times the memory ceiling, and the ceiling is what matters at scale: 32 frames of 64 KiB
elements is 2 MiB held per stream, and 256 concurrent streams makes that 512 MiB. At 128 it
is 2 GiB. So the knee is somewhere in 8 to 32, and 32 is the top of the flat region.

**Put the rate in context before reading the percentages.** The window costs 59% against an
unbounded producer, 27,470 elements per second rather than 67,616. A language model emits
something like 200 tokens per second. That is roughly **a hundredfold headroom** for the
workload this feature exists for, so the cost is invisible where it matters and the memory
bound is not. A percentage with no denominator invites the wrong conclusion; this is the
denominator.

**Every number above is localhost.** The credit round trip costs almost nothing here, so
this measurement understates how much a larger window is worth on a link with real latency.
32 is the top of the flat region partly to leave headroom the loopback cannot show.

**Refill must not exceed the window**, or the scheme deadlocks: the responder stops at zero
having sent fewer elements than the consumer needs before it will grant more, and both sides
wait for ever. Found by setting window 4 with refill 16 during the sweep, which hung. Half
the window is the conventional choice and is what is shipped.

### A responder with no credit waits, and something else has to notice

There is no timeout on the credit wait, and nothing in the scheme distinguishes a slow
consumer from a departed one. That is deliberate: "slow" is the case backpressure exists to
handle, and a responder cannot tell the difference from where it stands.

Session liveness is what makes the difference. When the session ends, every in-flight
response is aborted and every generator closed. That did not happen in the first
implementation: a parked producer survived its own session, holding a stream slot and
whatever the handler had open, for ever. Found by a test written for exactly this shape. An
application wanting a deadline of its own passes `AbortSignal.timeout(ms)` to `stream()`.

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
- **The gate for this lives on the real transport, and had to.** The same bound assertion
  over the loopback transport passes with the credit window widened to ten million, because
  the loopback applies backpressure of its own. It was green and meaningless. The bound is
  now proved in `stream.node.test.ts` over real QUIC, verified to go red when the window is
  widened; the loopback test is scoped down to what it can honestly show and says so.

### The other transport does not lie, and it does not change the decision

The same measurement against `@moq/web-transport`, behind the seam from ADR 0007:

| transport | credit window | producer ran ahead, consumer took 20 then 40 |
|---|---|---|
| reference binding | none | 77,273 then 127,998, growing with the run |
| reference binding | 32 | 33, flat |
| moq | none | 20,821 then 20,820, a genuine plateau |
| moq | 32 | 32, flat |

**moq honours `ready`.** It plateaus at about 20,800 frames, roughly 1.2 MB, which is its own
flow-control window rather than an accident. So on moq the credit scheme is not what makes
the stream bounded; it is what makes the bound **630 times tighter**, and what makes the
bound a number this library chose rather than one it inherited.

Two things follow. The scheme stays load-bearing on moq, so switching transports later
changes nothing here. And this is another data point for the seam: on the axis of throughput
the window costs 59% on the reference binding (27,470 against 67,616 elements per second) and
essentially nothing on moq (39,966 against 40,135), because moq was already applying the same
kind of backpressure the window makes explicit. Both figures are localhost, and both are two
orders of magnitude above what a model produces.

## Revisit when

- Anyone measures the window over a link with real latency. Every number here is localhost,
  where a credit round trip is nearly free, so the case for a larger window is systematically
  understated.
- A transport whose `writer.ready` is honest becomes the default. The credit window stays
  regardless - the responder is entitled to stop at zero and cannot know which transport it
  is on - but the window size becomes a tuning question rather than the only line of defence.
- Anyone measures a workload where 32 frames of credit is the wrong window. It is one
  constant in `protocol.ts` and one paragraph in the spec.
