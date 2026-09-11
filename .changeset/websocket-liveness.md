---
'transport-io': minor
---

The WebSocket fallback has a keepalive and an idle deadline. Each side sends an empty
message after 15 seconds with nothing sent, and closes the session as `WT_IDLE_TIMEOUT`
(close code 1005, 4005 on the socket) after 45 seconds without a message, so a dead TCP path
is noticed within that instead of never. A peer on an earlier release sends no keepalive and
is closed after 45 seconds of silence.
