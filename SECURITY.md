# Security policy

## Supported versions

The protocol is **v0 and unstable**, and the package is `0.x`. Only the latest published
version receives fixes. There are no backports.

| version | supported |
|---|---|
| latest `0.x` | yes |
| anything earlier | no |

## Reporting a vulnerability

Use GitHub's private vulnerability reporting on this repository:
**Security > Report a vulnerability**. That opens a private advisory visible only to the
maintainers. Use it for anything exploitable.

Please do not open a public issue for a vulnerability. Do open a public issue for the
limitations listed below, which are documented rather than secret.

What helps: the version, the platform, whether the native transport is installed, and a
reproduction. If a fix is obvious to you, say so, but a clear reproduction is worth more
than a patch.

## What this library does not protect you from

These are deliberate design positions rather than vulnerabilities. They are listed here so
you can see them before depending on the library.

**It authenticates nothing.** `Connection` exposes no headers, no URL, no peer address and
no identity, and `ServerOptions` has no reject hook. The only control an application has is
whether to call `accept()` at all, and the transport listener hands it nothing to decide on.
If you need authentication, terminate the HTTP/3 request behind something that authenticates
and do not route unauthenticated peers to the WebTransport endpoint.

**The handshake discloses your event names and lanes before any application code runs.**
`accept()` writes the full event table as frame 0. It is not payloads, not schemas and not
data, and for almost every application it is uninteresting. It is occasionally not: if your
event names encode unreleased features or internal structure, an unauthenticated peer can
read them, and refusing that peer afterwards does not undo it.

**A peer is not bound by your types.** A second implementation written from `PROTOCOL.md`
can send anything the wire permits. The library validates inbound payloads against the
contract's schemas, refuses malformed frames with typed errors, caps payload sizes by frame
type, bounds concurrent inbound streams whether they carry a call or a sequence, and discards
datagrams that arrive before the
handshake. It does not assume good faith. Report anything that gets past those.

**The WebSocket fallback carries the emit lane only, and only by declaration.** It has no
streams, so no call or `stream()` runs on it, and an unreliable event crosses it only where the
contract has declared what it accepts there; a contract with an undeclared one cannot be wired
to a fallback at all. Nothing degrades quietly: the snapshot says which transport carries a
session and why.

