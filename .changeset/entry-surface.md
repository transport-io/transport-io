---
'transport-io': minor
---

`transport-io/websocket-transport` exports `connectWebSocket` and its options and nothing
else: the connection class, the socket interface, the close-code helpers and the sink's
low-water mark are internal. `transport-io/node-transport` no longer exports
`resetCodeFromError`, which nothing called.
