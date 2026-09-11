---
title: Troubleshooting
description: Every error code in the order a newcomer meets them, with what it looks like and what to do.
---

Every error is a `TransportError` with a `code` and a `remedy`. A failed `connect()` rejects
with one and leaves it in the snapshot as `lastError`. A failed `call()` or `stream()` rejects
with one. A session that closes on an error leaves it in `lastError` too. The codes below are
in the order you are likely to meet them.

## WT_NO_SUPPORT

The runtime has no WebTransport. Safari, or anything that is not Chrome or Firefox. Use one
of those two, or give the client [the fallback](/guides/fallback/): a WebSocket that carries
emits, for a contract whose unreliable events declare what they accept there. With a fallback
configured, this code means the runtime has no WebSocket either.

## WT_HANDSHAKE_FAILED

`connect()` rejected. The browser reports one error for a server that is not running, a UDP
port that is unreachable, a wrong pinned hash and an expired certificate alike, so check in
this order: the server is running and its UDP port is reachable; a pinned certificate is
inside its 14 days; the hash is SHA-256 over the certificate's DER bytes, not over `cert.pem`.
`npx transport-io dev` handles all three locally. The message says whether the origin
answered over HTTPS. One that listens only on UDP never does, and is healthy. With a fallback
configured, the WebSocket was dialled after this and failed too.

## WT_UDP_UNREACHABLE

The handshake failed and the same origin answered over HTTPS, so the server is up and only
the QUIC path is failing: a firewall or VPN on this network, or a platform in front of the
server with no UDP ingress. Nothing in the library routes around it. With a fallback
configured the WebSocket is dialled, so this surfaces only when it failed too; without one,
the network is the fix. On a network where it worked before, rule out a wrong or expired
pinned hash, which fails the same way.

## WT_CERT_EXPIRED

`connectDev()` found the development certificate past its validity. Restart
`npx transport-io dev`, which mints a new one, then reload the page so it picks up the new
hash.

## WT_DEV_ONLY

`connectDev()` or `listenDev()` ran outside `transport-io dev`. The page is not on loopback;
or nothing serves the manifest at `/.well-known/transport-io-dev`, because the server was not
started through the command or the page is served by something else that does not proxy that
path to it; or the server process found no certificate in its environment. Anywhere that is
not local development, `connectBrowser` and `listenHttp3` with a certificate of your own.
See [Certificates](/guides/certificates/).

## WT_HANDSHAKE_TIMEOUT

The session opened and no application bytes arrived within 5000 ms. Safari does this: it
establishes a session and never sends. With a fallback configured, the WebSocket is dialled
when this fires over WebTransport, so a Safari user is connected after 5 seconds and you see
this error only when the WebSocket failed too. Without one, use Chrome or Firefox. On a
server, it is a client that connected and sent nothing.

## WT_PROTOCOL_VERSION_MISMATCH

The two sides speak different protocol versions and the session closed. The protocol requires
an exact match, so deploy both sides on the same library version. A minor release may change
the wire, so pin the minor.

## WT_CONTRACT_MISMATCH

An event both sides share is declared differently, a different lane or a different id, and
the session closed. Deploy the same contract on both ends. At `defineContract` it means two
event names hash to the same id: set an explicit `id` on one of them, and do not rename
events to get out of it.

## WT_RELIABILITY_REFUSED

The session was refused before the handshake because it cannot carry the unreliable lane as
declared: a WebSocket session with an unreliable event that declares no fallback, or a
WebTransport session negotiated reliable-only. Declare a fallback on every unreliable event,
`unreliable(schema, { fallback: 'newest' })`, or connect over WebTransport.

## WT_LANE_UNAVAILABLE

`call()` or `stream()` on a fallback session. A WebSocket has no bidirectional streams. Check
`client.native` first: it is `null` on a fallback session and the client on a WebTransport
one. Emits, and unreliable events that declare a fallback, still work.

## WT_UNKNOWN_EVENT

The event is not in the contract, or the method does not match its declaration: `call()` on
an event that is not `rpc`, `stream()` on one that is not `streaming`. Add it, check the
spelling, or use the method the declaration asks for.

## WT_VALIDATION_FAILED

A payload failed the contract's schema on arrival, and the message names the field. Or a
payload could not be serialised on the way out: a cycle, a function, a `BigInt`, or
`undefined` as the whole payload. Send `null` rather than `undefined`. See
[Types, or a schema](/guides/schema/).

## WT_HANDLER_ERROR

The responder's handler threw. `call()` or `stream()` rejects with the handler's message, and
with this code unless the handler threw a `TransportError`, whose own code is carried
instead. For a stream, the elements yielded before the throw were delivered.

## WT_ABORTED

The caller's signal fired, the deadline passed, or `cancel()` was called. The stream was
reset, so the responder was told and its `ctx.signal` fired. This is routine. Retry if the
work is idempotent, or raise the deadline.

## WT_SESSION_CLOSED

The session closed while the operation was pending, or `emit()` ran before `connect()`
resolved. Reconnect. A reconnect is a new session and does not restore room membership. See
[Reconnecting](/guides/reconnect/).

## WT_PEER_TOO_SLOW

The emit queue passed 256 frames and the session closed. The other side is not consuming as
fast as this side emits. Emit less, or move the high-rate event to the unreliable lane, where
the newest wins and the queue drops rather than closes. See
[Backpressure](/guides/backpressure/).

## WT_TOO_MANY_STREAMS

More than 256 calls open at once on one session. The excess stream is reset without being
read and the session stays open. Reduce concurrency and retry.

## WT_DATAGRAM_TOO_LARGE

An unreliable payload larger than the path allows. The message gives both sizes. Shorten it,
or declare the event `reliable`, where the cap is much higher.

## WT_PAYLOAD_TOO_LARGE

A reliable frame above the cap for its type. The message gives both sizes. Use a call rather
than an emit, or split the payload. The caps are in the
[wire protocol](/protocol/#51-field-budget).

## WT_HANDSHAKE_INCOMPLETE

A frame arrived before the handshake. Between two copies of this library it does not happen.
Another implementation is sending before its handshake frame.

## WT_PROTOCOL_ERROR

A framing violation: a bad frame, a zero-length payload, an unknown frame type. Between two
copies of this library on the same version it does not happen, and the message names the
section of the wire protocol to check the other implementation against. Locally it also
means `call()` on an `unreliable` event, which has no response to await: use `emit()`, or
declare the event on the reliable lane.

## WT_UNSUPPORTED_CODEC

A frame declares a codec other than JSON, which is the only one this version speaks. Another
implementation is sending it.

## WT_ROOM_NOT_JOINED

In the code list and never raised by this version. Rooms are server-authoritative, so there
is no client-side room operation to refuse.
