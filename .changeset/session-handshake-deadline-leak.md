---
'transport-io': patch
---

A session disposed or failed before its handshake completed left its handshake-deadline timer
armed for the rest of the deadline, five seconds by default. It then fired into a session that
no longer existed. The timer now belongs to the session rather than to `start()`: `start()`
clears it on every exit, and `dispose()` releases it and settles the handshake with
`WT_SESSION_CLOSED` instead of leaving `start()` parked on a peer that can no longer answer.

A peer that goes away mid-handshake is therefore reported to `server.accept()` when it
happens rather than after the deadline. If you call `server.accept()` directly, handle its
rejection; `server.listen()` already routes it to `onAcceptError`.
