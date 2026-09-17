---
'transport-io': patch
---

`onSession` runs before anything from that session reaches a handler, on the client and on
the server. It was true over the loopback and false when the peer's handshake and its first
emit arrived in one read: the event reached its handler first, and on the server a handler
registered in `onSession` missed it. What the peer sent after its handshake is now held until
every `onSession` callback has returned, so state cleared there, before any `await`, is
cleared before the session's first event.
