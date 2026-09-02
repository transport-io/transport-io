---
title: Backpressure
description: What a slow consumer causes, and where the bound comes from.
---

A slow consumer stalls its own stream. Other streams on the session are unaffected.

## How it works

A streaming responder spends credit. It starts with 32 frames and spends one per element
written. At zero it waits. The consumer grants more as it takes elements, in batches of 16.
The iterator's `next()` is the signal: asking for the next value refills the window.

A consumer that reads slowly slows the generator. A consumer that stops reading parks it.
Nothing is dropped and nothing is buffered without limit. Each stream has its own QUIC
stream, so none of this reaches the rest of the session.

## Where the bound comes from

The credit accounting is this library's, not the transport's. The measurement behind that is
D93.

## What it costs

<div class="tio-figure">
27,470 elements per second with the window, against 67,616 without it. That is a 59%
reduction, and the denominator matters: a language model emits on the order of 200 tokens
per second, so the bounded path still carries about a hundred times what the workload this
exists for can produce. Both figures are measured over localhost, where the credit round
trip is nearly free.
</div>

## A consumer that never comes back

There is no timeout on the credit wait. A responder cannot distinguish a slow consumer from
a departed one, and waiting is the correct response to the first.

Session liveness handles the second. When the session ends, every response still being
served is aborted and every generator is closed. Pass an `AbortSignal` to `stream()` if you
want a deadline of your own.

## The other lanes

Each lane is bounded differently.

| lane | bound | on overflow |
|---|---|---|
| Unreliable, per peer | 64 frames | Discard oldest, count it, never error. |
| Emit, per peer | 256 frames | Close the session with `WT_PEER_TOO_SLOW`. |
| Stream response | 32 frames of credit | Producer waits. Never discard. |

The emit lane never discards. It advertises reliable ordered delivery, so dropping would
misreport what happened to your data. A peer 256 frames behind is disconnected instead.
