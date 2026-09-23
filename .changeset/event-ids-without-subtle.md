---
'transport-io': patch
---

A page that is not a secure context, `http` on any host but loopback, now connects through the
WebSocket fallback. It has no `crypto.subtle`, and building the event table threw a `TypeError`
before either connector ran, so a `withFallback` client there never connected. The event ids
now come from `crypto.subtle` where there is one and otherwise from SHA-256 in `@noble/hashes`,
loaded on demand as a chunk of its own, so no other page pays for it. The ids are the same to
the byte, and the snapshot says `fallbackReason: 'unsupported'`, as it does for any runtime
with no WebTransport. `@noble/hashes` 2.4.0 is a new dependency.
