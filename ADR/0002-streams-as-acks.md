# ADR 0002 — Acknowledgements are streams, not bookkeeping

**Status:** accepted · **Decision:** D2, D7

## Decision

Each `call` opens its own bidirectional QUIC stream. The initiator writes one request
frame and closes its send side; the responder writes frames and closes. The stream is the
correlation. There are no acknowledgement identifiers, no pending-callback map and no
timeout tracking.

The response is a **sequence** of frames terminated by stream close, even though version 0
sends at most one.

## Alternative rejected

Socket.IO's model: one multiplexed channel, an incrementing ack id per request, a map from
id to pending callback, and a timer per entry to clean up.

That machinery exists only because everything shares one channel. It brings an id space to
manage, a map that leaks if a response never arrives, a timeout that must be tuned, and
head-of-line blocking — one slow response delays every other message on the connection.

## Why this way

QUIC already provides independent, ordered, flow-controlled streams. Modelling a call as a
stream means the transport supplies correlation, ordering, cleanup and isolation for free.
A stalled call consumes one stream and blocks nothing else. Cancellation becomes a stream
reset rather than an application-level protocol.

Making the response a frame sequence rather than a single length-prefixed frame costs
nothing today and is what allows incremental responses to be added later without a
protocol break.

## Revisit when

**This trigger has fired.** The soak measured 11.6 KB of unbounded heap growth per
bidirectional stream, which is 408 MB/h at ten calls per second. See D65.

It did not fire on the design. transport-io over an in-memory transport costs 0.045 KB per
call — the model is sound — and the binding leaks the same 11.76 KB with none of our code
present. The cost is in one implementation of one transport, which is what ADR 0007's seam
exists to make replaceable. A stream per call stays.

The original trigger, for the record: RSS growth above 4 MB/h by linear fit, or p99 call
latency above 50 ms at 500 concurrent sessions with no network cause. Both are measured by the same
harness, so this trigger fires from evidence already being collected rather than from an
impression that "churn feels expensive".

The known risk is upstream memory growth under high stream turnover, which is why that soak
is a Stage 1 graduation criterion rather than a nice-to-have.
