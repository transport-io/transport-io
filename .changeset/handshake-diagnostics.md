---
'transport-io': minor
---

A failed handshake is no longer an opaque browser error. Measured in Chromium, a wrong pinned
hash, an expired certificate and an unreachable server all produce the identical
`WebTransportError` with no own properties, so `connectBrowser` now raises
`WT_HANDSHAKE_FAILED` with a remedy naming all three in the order worth ruling them out, and
keeps the original error as `cause`. It does not guess which cause it was.

`connectDev` does not have to guess: `transport-io dev` publishes the certificate's expiry
alongside its hash, so an expired certificate raises `WT_CERT_EXPIRED` before the connection
is attempted, naming the command that mints a new one.

`TransportError` takes an optional fourth argument, `cause`.
