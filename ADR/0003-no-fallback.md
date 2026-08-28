# ADR 0003 - No fallback, and the dependency's fallback is disabled

**Status:** accepted · **Decision:** D3, D10, D11

## Decision

WebTransport over HTTP/3 only. No WebSocket fallback, no HTTP/2 WebTransport, under any
condition. An unsupported runtime is unsupported and says so with `WT_NO_SUPPORT`.

## Alternative rejected

A WebSocket fallback for browsers or networks where QUIC is unavailable.

A WebSocket is reliable and ordered. Running the unreliable lane over one would silently
convert every `lane: 'unreliable'` event into a reliable, ordered one. The contract would
still say the message may be dropped; the transport would guarantee it never is. The
application would be built on a guarantee that does not hold, and the mismatch would be invisible
precisely where it matters - under the network conditions that triggered the fallback.

Degrading availability is honest. Degrading a guarantee is not.

## The part that is not obvious

**The server dependency ships exactly this fallback, and it is on by default.** The
reference implementation catches a failed QUIC connection and switches to WebTransport
over HTTP/2, and it exposes an `Http2Server` and a `reliability: 'both'` mode. At least one
browser advertises its own HTTP/2 fallback "with the same API".

So the decision is not only "do not build a fallback". It is "actively disable the one
we depend on":

- Construct only `Http3Server`. Never `Http2Server`, never `reliability: 'both'`.
- This is the real guarantee, because it is browser-independent: a server that never
  offers the HTTP/2 mapping cannot be negotiated into it.

The obvious client-side guard does not work. The dominant browser implements neither
`requireUnreliable` nor `session.reliability`, so asserting
`reliability === 'supports-unreliable'` would refuse every session on it. The client check
is therefore defence in depth: set `requireUnreliable` where supported, and assert
`reliability !== 'reliable-only'` so an absent property passes.

## Consequence accepted

One major browser cannot talk to a server built on this stack at all, because the
underlying QUIC library does not implement the session-level flow-control settings that
browser requires. It is unsupported in v1 and the README says so. The failure is not a
clean one: feature detection reports success and the session establishes before failing, so
the handshake deadline in ADR 0009 exists to turn that silence into a named
error.

## Revisit when

The upstream QUIC library advertises the WebTransport session-level flow-control
**SETTINGS** the browser requires - `WT_INITIAL_MAX_DATA` and
`WT_INITIAL_MAX_STREAMS_UNI`/`_BIDI` - observable as those names appearing in the shipped
binary's strings alongside the `SETTINGS_WEBTRANS_MAX_SESSIONS_DRAFT07` it already carries.

The earlier wording of this trigger named the `WT_MAX_DATA` **capsule**, which was the
first diagnosis and the wrong one. The capsule is a different mechanism at a different
layer; watching for it would have missed the fix when it arrived. The reference
implementation in Go fixed the same bug in 29 lines by advertising four SETTINGS values,
which is what makes this a realistic trigger rather than a hopeful one.
