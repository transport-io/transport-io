---
'transport-io': minor
---

A WebTransport session that connects and then sends nothing before the application
handshake dials the fallback: on `WT_HANDSHAKE_TIMEOUT` over WebTransport, with a fallback
configured, the WebSocket is dialled and a new session started over it, reported as
`fallbackReason: 'unsupported'`. That is Safari, which now gets the emit lane 5 seconds after
each connect and each reconnect. `unsupported` means the runtime has no WebTransport it can
use against this server; `unreachable` means the WebTransport handshake failed and the
WebSocket connected. If the WebSocket fails too, the WebTransport error is thrown as before.
