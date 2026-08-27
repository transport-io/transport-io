---
title: Backpressure
description: What a slow consumer actually causes, and why the bound is this library's rather than the transport's.
---

A slow consumer stalls its own stream and nothing else. That is the whole behaviour, and the
interesting part is what makes it true.

## What actually happens

A streaming responder spends **credit**. It starts with 32 frames, spends one per element
written, and **waits at zero**. The consumer grants more as it takes elements, in batches of
16, and the signal is the iterator's `next()`: asking for the next value is what refills the
window.

So a consumer that reads slowly slows the generator. A consumer that stops reading parks it.
Nothing is dropped, nothing is buffered without limit, and no other stream on the session is
affected, because each one owns its own QUIC stream.

## The bound is ours, and it had to be

The obvious design is to let the transport do this. Await the writer before each write, let
its flow control push back, and write no accounting at all. That was the original plan and
the first stated reason for choosing an async iterable.

**It was measured and it is false.** On the reference QUIC binding,
`WritableStreamDefaultWriter.ready` resolves unconditionally: awaiting it accepts nothing and
holds nothing back.

| consumer took | producer got ahead |
|---|---|
| 20 elements | 83,461 frames |
| 40 elements | 136,523 frames, about 53 MB |

No plateau at any element size from 16 bytes to 64 KiB, and the gap grew linearly with the
run. That is not a slow consumer being handled, it is an unbounded buffer with a nicer API
on top. With the credit window the same measurement is **33 frames, flat**, unchanged when
the run doubles.

A bound is only a bound if something stays in the bounded thing, and nothing was staying
anywhere.

## What it costs

<div class="tio-figure">
27,470 elements per second with the window, against 67,616 without it. That is a 59%
reduction, and the denominator matters: a language model emits on the order of 200 tokens
per second, so the bounded path still carries about a hundred times what the workload this
exists for can produce. Both figures are measured over localhost, where the credit round
trip is nearly free.
</div>

The window is 32 because the bound is always window + 1 and the throughput curve is flat
between 8 and 32. A window of 4 costs about 29%; a window of 128 buys 28% for four times the
memory ceiling, which at 64 KiB elements and 256 concurrent streams is 2 GiB against 512 MiB.

## A consumer that never comes back

There is no timeout on the credit wait, and nothing distinguishes a slow consumer from a
departed one. That is deliberate: slow is the case backpressure exists to serve, and the
responder cannot tell the difference from where it stands.

Session liveness makes the distinction instead. When the session ends, every response still
being served is aborted and every generator closed, so a parked producer cannot outlive its
peer. If you want a deadline of your own, pass an `AbortSignal`.

## The other lanes

Each lane resolves this differently, because each promises something different.

| lane | bound | on overflow |
|---|---|---|
| Unreliable, per peer | 64 frames | Discard oldest, count it, never error. |
| Emit, per peer | 256 frames | Close the session with `WT_PEER_TOO_SLOW`. |
| Stream response | 32 frames of credit | Producer waits. Never discard. |

The emit lane never discards, because a lane advertising reliable ordered delivery that
drops silently is a lie about your data. A peer 256 frames behind has already failed, and
disconnecting it is the honest outcome.
