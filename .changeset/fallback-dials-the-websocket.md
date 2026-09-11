---
'transport-io': patch
---

`withFallback` dials the WebSocket when the WebTransport handshake fails, not only when the
WebTransport origin answers a probe over HTTPS. WebTransport on one port and the WebSocket on
another behind a proxy, the deployment the guide documents, now falls back with no `probe` set
by hand. If the WebSocket fails too, the WebTransport error is thrown as before.
