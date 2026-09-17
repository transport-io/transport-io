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

**Nothing can stand in front of it, so the door is `authorize`.** The WebTransport endpoint is
QUIC over UDP to your process: a proxy, a load balancer or a CDN in front of it terminates TLS
and drops UDP, and no session arrives. A listener's `authorize` decides each peer from the
request that opened the session, its path, query, peer address and headers, before the session
is accepted; on the WebSocket listener the headers are the upgrade request's, cookies
included. A browser sends no cookies and no custom headers on a WebTransport request, so a
token travels in the query string, and the page obtains that token over HTTPS. What
`authorize` returns is `peer.data`, checked by nobody after that: it is your value. This
library keeps the query out of its own errors: a failed handshake names the origin and the
path it dialled and nothing after them. A URL your own code logs is yours to scrub.

**No origin is checked.** Some WebSocket libraries refuse an upgrade whose `Origin` is not
the server's own, and this library has no such check on either listener. With no `authorize`, every
peer is accepted, from any page and from anything that is not a page at all. `authorize` is
handed the request's headers, and a browser puts the page's `origin` there on a WebTransport
request, measured in Chromium, so an application that wants only its own pages to connect
compares `headers.origin` in `authorize`. That stops another site's page from using a
visitor's browser to reach your server. It does not stop a program, which sends whatever
origin it likes: the token is what authenticates, and the origin check is beside it.

**A token in the query is seen by more than your server, so it has to be short-lived.** When
a handshake fails, the browser prints its own console error with the whole URL, query
included: `Failed to establish a connection to https://…/?token=…`. The error handed to
JavaScript carries no URL, so there is nothing for a library to redact, and no library can
suppress the browser's own line. Any log that records request paths has the token as well, a
reverse proxy's access log in front of the WebSocket fallback for one. Mint the token for the
connection and let it expire soon after. A day is too long for anything real.

**The handshake discloses your event names and lanes to every peer `authorize` accepts, and
to every peer when there is no `authorize`.** A refused peer is closed before frame 0 and
receives the reason and nothing else. An accepted one receives the full event table before
any handler runs. It is not payloads, not schemas and not data, and for almost every
application it is uninteresting; if your event names encode unreleased features or internal
structure, refuse at the door.

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

