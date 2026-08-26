---
'transport-io': patch
---

`Session.close()` is idempotent in both halves. `dispose()` already was, but the underlying
`conn.close()` was not, so a client disconnecting while the server tore the same session down
— ordinary, and constant under load — reached the transport twice. quiche logged
"WebTransportHttp3 close sent twice" and refused the extra call; a 60-minute soak produced
865,464 of those lines, which was loud enough to bury the soak's own output.
