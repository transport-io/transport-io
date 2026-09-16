---
'transport-io': minor
---

A listener decides each peer at the door: `listenHttp3`, `listenDev` and `listenWebSocket`
take `authorize`, which receives the request's path, query and peer address (the WebSocket
one its headers too) before the session is accepted. What it returns is `peer.data`, typed
by the second type argument of `createServer<M, D>` and assignable; `null` closes the
session as `WT_UNAUTHORIZED` (close code 1007) before the server's frame 0, so a refused
peer never receives the event table, and the client's `connect()` rejects with that code and
the server's reason. A WebTransport URL may now carry a query string, which is where a
browser puts a token. A departure is visible twice: `server.onDisconnecting((peer, info) =>
…)` runs before the peer leaves its rooms, and `peer.closed` settles after.
