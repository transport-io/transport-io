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

The first release is `0.1.0`. (`0.0.1` is on the registry to claim the name, from the same
tree, and is not a release.) Under `0.x` a **minor** bump is allowed to contain breaking
changes - pin an exact version, or accept that `^0.1.0` can move under you.

Every breaking change still gets a version bump and a changelog entry. What `0.x` withholds
is the promise that a minor bump is safe, and that is deliberate: `call()` ships with a
documented upstream leak, and an audit shortly before this release turned up thirty-one
things worth fixing. The API is not settled yet. See D83.

---

Security-relevant limits, including the fact that this library authenticates nothing, are
in [`SECURITY.md`](SECURITY.md). The reasoning behind every position on this page is in
[`DECISIONS.md`](DECISIONS.md).
