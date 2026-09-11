# Known issues and deliberate limits

Most of what follows is deliberate. It describes what this library will not do, and why,
so you can decide before you build on it. None of it is going to change.

## Chrome and Firefox only

Safari ships WebTransport and still cannot talk to a server built on this stack. It waits
for session-level flow-control SETTINGS that the underlying QUIC library does not send, so
feature detection reports success, the session establishes, and then no application bytes
ever flow. That is the worst failure mode available, which is why the client turns it into
a named error with a deadline rather than hanging. Safari is unsupported until the fix
lands upstream. The WebSocket fallback does not cover it: the fallback engages when the
runtime has no WebTransport or the WebTransport handshake fails, and on Safari the transport
handshake succeeds, so the session times out as `WT_HANDSHAKE_TIMEOUT` and no fallback is
tried.

**Firefox does support `serverCertificateHashes`**, so the local-development recipe is not
Chrome-only. Its first implementation treated the hashes as an extra check on top of Web PKI
rather than a replacement for it, which meant self-signed certificates failed even when the
hash matched; that was Mozilla bug 1873263, resolved fixed, shipped in Firefox 125. The
support matrix therefore has one answer, not one for development and another for production.

## A wrong pinned certificate is indistinguishable from a server that is down

Measured in Chromium against a real server, all three of these produce the identical error -
`WebTransportError`, message `Opening handshake failed.`, `code: 0`, `source: 'session'`, and
no own enumerable properties at all:

- a hash that does not match the certificate,
- a correct hash for a certificate that has expired,
- nothing listening on the port.

So the browser gives a client no way to tell them apart. Two things reduce how much that
costs you.

`connectBrowser` no longer passes that error through untouched: it raises
`WT_HANDSHAKE_FAILED`, whose remedy names all three candidates in the order worth ruling them
out, and keeps the original error as `cause`. It does not guess which one it was, because
naming a cause would be wrong two times in three.

It does check the one fact that is available. After the failure it asks whether the same
origin answers over HTTPS, at `/.well-known/transport-io`, and if it does the error is
`WT_UDP_UNREACHABLE` instead: the server is up, and UDP is not reaching it.

`connectDev` does better, because it does not have to infer anything. `transport-io dev`
publishes the certificate's expiry alongside its hash, so an expired certificate is refused
before the connection is attempted, with `WT_CERT_EXPIRED` and the command that fixes it.
That removes the trap entirely from the path a newcomer takes.

## The fallback carries the emit lane only, and only by declaration

A WebSocket is reliable and ordered, so it cannot carry a `lane: 'unreliable'` event as the
contract describes it, and it has no streams to carry a call or a `stream()` on. So the
fallback carries emits and nothing else. `call()` and `stream()` are not methods of a client
built with `withFallback`; they live on `native`, which is `null` on a fallback session, and
the compiler makes that check unavoidable. An unreliable event crosses the fallback only when
the contract says what it accepts there, `fallback: 'newest'`: in order, with the oldest and
the stale dropped at the sender as the datagram ring drops them. A contract with an
unreliable event that declares nothing cannot be wired to a fallback at all; the line that
adds one fails to compile and names the event, and a session that reaches the wire anyway is
refused with `WT_RELIABILITY_REFUSED` before the handshake.

The fallback engages on two conditions and no other: the runtime has no WebTransport, or the
WebTransport handshake fails and the WebSocket connects. A dead server fails both and reports
the WebTransport error. A wrong or expired pinned hash fails the handshake as a blocked path
does, and falls back the same way. Every reconnect starts from WebTransport again. A
WebSocket has no idle timeout of its own, so the mapping carries one: a keepalive after 15
seconds of silence, and a close after 45 seconds without a message. A dead TCP path is
noticed within that, and a proxy whose idle timeout is under 15 seconds closes a quiet
session first.

## Reconnect creates a new session

A reconnection is a new session with a new identity. Room membership does not survive it,
and pending calls reject. Re-establishing authentication and resubscribing is your job -
the library gives you the primitive and the hook, because whether a call was executed
before the connection dropped is unknowable from the client, and pretending otherwise
means silently risking duplicate execution.

## Datagrams may be dropped, duplicated or reordered

On the unreliable lane there is no delivery guarantee, no ordering guarantee, no
acknowledgement, no retransmission, and no flow-control feedback. Duplicates are discarded
for you and stale arrivals are dropped rather than rendered as history, but loss is
reported to nobody because loss is the contract. Anything that cannot tolerate this belongs
on the reliable lane, and the contract is where you say which.

## It requires raw UDP ingress to your process

On the port you listen on. Unlike TCP, many managed platforms do not provide this. Verify
your platform routes UDP before building on this library - it is the first thing to check
when nothing connects, and no amount of application code works around it. A client that
reaches the server over TCP but not over QUIC reports `WT_UDP_UNREACHABLE`, which is the
first thing to look for when nothing connects on a managed platform.

## The emit lane blocks across rooms

All rooms share one emit stream per direction, so a high-volume room delays a quiet room's
messages to the same peer. Calls and datagrams are fully isolated - they use separate
streams and separate packets - but emits to one peer are serialised across every room that
peer belongs to. Per-room lanes are reserved as a negotiated feature and are not in this
version. So "independent streams" is not a promise about emits.

## The reference transport applies no write backpressure

Upstream, in the QUIC binding, and invisible until you look for it: `WritableStreamDefaultWriter.ready` resolves unconditionally. Awaiting it, which
is what the streams contract says to do before writing, holds nothing back at all.

Measured with a producer writing as fast as it can against a consumer taking one element
every 20 ms:

| consumer took | producer got ahead | in flight |
|---|---|---|
| 20 | 77,273 frames | growing |
| 40 | 127,998 frames | growing |

No plateau at any element size tried, from 16 bytes to 64 KiB, and roughly 53 MB resident at
the large end. The same probe against `@moq/web-transport` plateaus at about 20,800 frames,
so this is the binding rather than something inherent.

**This library does not rely on it.** `stream()` carries its own credit window, so a
streaming responder is held to 32 frames ahead of what the consumer has taken regardless of
what the transport does. The entry is here because it is a fact about the binding you are
depending on, and because anything you write that talks to that transport directly is
affected. Reproducible from `packages/core/src/bench/stream-credit-window.node.ts`.

The window costs throughput: 27,470 elements per second against 67,616 without it. Worth
stating what that is a percentage *of*, because 59% sounds like a lot. A language model
emits on the order of 200 tokens per second, so the bounded path still carries about a
hundred times what the workload this exists for can produce. Both numbers are measured over
localhost, where a credit round trip is nearly free.

## A session is capped at 256 concurrent streams

`call()` and `stream()` share it, and the 257th open is refused with `WT_TOO_MANY_STREAMS`
while the session stays up.

The unit matters more now that streams exist. A `call()` holds a slot for a round trip; a
`stream()` holds one for as long as it runs. An agent app running ten generations at once
occupies ten slots for minutes at a time, which is fine and well inside the cap. Ten
thousand concurrent generations on one session is not, and the failure is a clean refusal
rather than a degradation.

## Protocol versioning

The handshake carries a version. **A major mismatch refuses the session; the minor surface
is the intersection of both sides' feature lists**, so older peers keep working and newer
ones light up extras. Adding or removing an event is a rolling-deploy-safe change, because
event identity is derived from the event's name rather than its position. Changing an
event's lane is breaking and is refused at connect, by design: it changes a guarantee.

**The protocol is v0 and unstable.** Both sides currently require an exact match. The
negotiation mechanism exists; the compatibility promise does not, and will not until the
first stable release.

## The package is `0.x`, and a minor bump may break you

Under `0.x` a **minor** bump is allowed to contain breaking changes, and this project uses
that latitude: a minor release may change the wire, so two peers on different minors may
refuse each other.

A caret range does not expose you to that, which is the opposite of what this page used to
say: npm reads `^0.4.0` as `>=0.4.0 <0.5.0`, so it admits patches and stops at the next
minor. What exposes you is a fresh install, because `npm install transport-io` takes whatever
minor is current on the day it runs. Pin the minor, which a caret already does, and read the
changelog before you move it.


Every breaking change still gets a version bump and a changelog entry. What `0.x` withholds
is the promise that a minor bump is safe, and that is deliberate: an audit shortly before
the first release turned up thirty-one things worth fixing. The API is not settled yet. See
D83.

## One event name for both directions is a modelling tax

An event that a client sends and a server rebroadcasts is one contract entry doing two jobs,
and the payload ends up being the union of what both directions need. `examples/chat` shows
it: `cursor` carries `from`, which the sender fills in about itself and every receiver reads
about someone else. The server has to either trust that field or overwrite it.

Modelled cleanly it is two entries, `cursor` outbound and something like `cursorMoved`
inbound, which doubles the contract for every broadcast event and puts two names in the
reader's head for one idea.

Both shapes are available today and neither is enforced. No design is being rushed for it:
the cost is real and the fix is not obviously better than the tax. Documented so the choice
is made deliberately rather than discovered halfway through an application.

---

Security-relevant limits, including the fact that this library authenticates nothing, are
in [`SECURITY.md`](SECURITY.md). The reasoning behind every position on this page is in
[`DECISIONS.md`](DECISIONS.md).

## Resolved upstream

- Per-stream memory retention in the reference binding, found during development, reported
  in [fails-components/webtransport#510](https://github.com/fails-components/webtransport/pull/510),
  fixed in 1.6.8 by [#511](https://github.com/fails-components/webtransport/pull/511).
