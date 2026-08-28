# Known issues and deliberate limits

Most of what follows is deliberate. It describes what this library will not do, and why,
so you can decide before you build on it. None of it is going to change.

One entry is different: [each call leaks memory](#each-call-leaks-memory) is a real bug,
in a dependency, with a measured cost.

## Chrome and Firefox only

Safari ships WebTransport and still cannot talk to a server built on this stack. It waits
for session-level flow-control SETTINGS that the underlying QUIC library does not send, so
feature detection reports success, the session establishes, and then no application bytes
ever flow. That is the worst failure mode available, which is why the client turns it into
a named error with a deadline rather than hanging. Safari is unsupported until the fix
lands upstream.

## There is no fallback

Not to WebSocket, not to anything. A WebSocket is reliable and ordered, so falling back to
one would silently convert every `lane: 'unreliable'` event into a reliable one - your
contract would still say the message may be dropped while the transport guaranteed it
never is. Degrading availability is honest. Degrading a guarantee is not. An unsupported
runtime gets `WT_NO_SUPPORT` and nothing else.

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
when nothing connects, and no amount of application code works around it.

## The emit lane blocks across rooms

All rooms share one emit stream per direction, so a high-volume room delays a quiet room's
messages to the same peer. Calls and datagrams are fully isolated - they use separate
streams and separate packets - but emits to one peer are serialised across every room that
peer belongs to. Per-room lanes are reserved as a negotiated feature and are not in this
version. So "independent streams" is not a promise about emits.

## Each call leaks memory

Unlike the rest of this page, this one is a bug.

Every `call()` opens its own bidirectional stream, and the QUIC binding this library ships
against leaks roughly **5.95 KB of server memory per stream**, unbounded. At ten calls per
second that is about 209 MB an hour. It is not this library's leak - the same code over an
in-memory transport costs 0.045 KB per call, and the binding leaks the same amount with
none of this library's code present - but it is what you get if you deploy this today.

**It is not tracked upstream.** An issue describing it was opened against the binding and
then withdrawn before any maintainer replied, so nobody upstream has seen this. Do not plan
around a fix arriving. The measurement is ours and is reproducible from
`packages/core/src/bench/stream-churn.node.ts`; that is the whole of its provenance.

An alternative transport measures flat on the same benchmark and is wired up behind an
internal seam, but it cannot shut a server down gracefully and does not deliver call
cancellation to the responder, so it is not the default yet.

If your workload is mostly `emit` and datagrams, this does not affect you: both are flat,
and you can check for yourself: `npm run soak:lanes` runs the memory soak over those two
lanes and passes.

**`stream()` is the cheaper shape for the same work.** The leak is per bidirectional stream,
not per message, so one generation that streams a thousand tokens down one stream costs 5.95
KB in total. The same thousand tokens fetched as a thousand `call()`s cost 5.95 KB each. If
you are building an agent, streaming is both the better interface and the smaller leak.

## The reference transport applies no write backpressure

Also upstream, also in the QUIC binding, and unlike the leak above it is invisible until you
look for it: `WritableStreamDefaultWriter.ready` resolves unconditionally. Awaiting it, which
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

The first release was `0.1.0`. (`0.0.1` is on the registry to claim the name, from the same
tree, and is not a release.) Under `0.x` a **minor** bump is allowed to contain breaking
changes - pin an exact version, or accept that `^0.4.0` can move under you.

`0.2.0` is the demonstration: it renamed both lane values and changed the handshake, so a
`0.1.0` peer and a `0.2.0` peer refuse each other. That is what a minor bump is permitted to
do here.

Every breaking change still gets a version bump and a changelog entry. What `0.x` withholds
is the promise that a minor bump is safe, and that is deliberate: `call()` ships with a
documented upstream leak, and an audit shortly before this release turned up thirty-one
things worth fixing. The API is not settled yet. See D83.

## A call handler does not know which peer called it

`server.handle(event, handler)` registers one handler for every peer, and the context it
receives is `{ signal }`. There is no `ctx.peer`, so a call cannot join the caller to a room,
check the caller's permissions, or answer differently per peer. Taking a peer id in the
payload does not close the gap, because the server cannot verify a client sent its own.

Per-peer handlers exist and they are event handlers: `peer.on(...)` inside `onSession` has
the peer. So an authenticated request with a reply is written as two events, one in each
direction, which is the bookkeeping `call()` exists to remove. The
[reconnect guide](https://transport-io.github.io/transport-io/guides/reconnect/) spells the
shape out.

This is a gap rather than a decision. It is recorded here because it changes what an
application can write today.

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
