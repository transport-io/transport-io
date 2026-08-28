# ADR 0002 - Acknowledgements are streams, not bookkeeping

**Status:** accepted · **Decision:** D2, D7

## Decision

Each `call` opens its own bidirectional QUIC stream. The initiator writes one request
frame and closes its send side; the responder writes frames and closes. The stream is the
correlation. There are no acknowledgement identifiers, no pending-callback map and no
timeout tracking.

The response is a **sequence** of frames terminated by stream close. An event declaring
`returns` sends exactly one frame; an event declaring `yields` sends as many as it likes.
Both shapes were reserved here and only the first was implemented at the time.

## Alternative rejected

Socket.IO's model: one multiplexed channel, an incrementing ack id per request, a map from
id to pending callback, and a timer per entry to clean up.

That machinery exists only because everything shares one channel. It brings an id space to
manage, a map that leaks if a response never arrives, a timeout that must be tuned, and
head-of-line blocking - one slow response delays every other message on the connection.

## Why this way

QUIC already provides independent, ordered, flow-controlled streams. Modelling a call as a
stream means the transport supplies correlation, ordering, cleanup and isolation for free.
A stalled call consumes one stream and blocks nothing else. Cancellation becomes a stream
reset rather than an application-level protocol.

Making the response a frame sequence rather than a single length-prefixed frame cost nothing
at the time and is what let `stream()` arrive in 0.2.0 without a protocol break. The bet paid
out for the response shape: no response frame type changed, and `stream()` needed no break
of its own. It did not buy cross-version interop, and this record originally claimed it did:
the same 0.2.0 release renamed both lane values and changed the handshake, so a 0.1.0 peer
and a 0.2.0 peer refuse each other (D92). The streaming bet and the lane rename were
independent, and only the first one was free. See ADR 0012.

## Revisit when

**This trigger has fired.** The soak measured 11.6 KB of unbounded heap growth per
bidirectional stream, which is 408 MB/h at ten calls per second. See D65.

It did not fire on the design. transport-io over an in-memory transport costs 0.045 KB per
call - the model is sound - and the binding leaks the same 11.76 KB with none of our code
present. The cost is in one implementation of one transport, which is what ADR 0007's seam
exists to make replaceable. A stream per call stays.

The original trigger, for the record: RSS growth above 4 MB/h by linear fit, or p99 call
latency above 50 ms at 500 concurrent sessions with no network cause. Only the first half is
measured today: the soak harness fits RSS growth and does not record call latency at all, so
the p99 half of this trigger cannot fire until something measures it.

The known risk is upstream memory growth under high stream turnover. That soak is a Stage 1
graduation criterion.
