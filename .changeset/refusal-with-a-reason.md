---
'transport-io': minor
---

A refusal says why, and is final. `authorize` may return `refuse('expired')`; the reason is a
code of 1 to 123 bytes that travels as the close reason, and `null` is the reason
`'refused'`. `connect()` rejects with a `RefusedError`, `code: 'WT_UNAUTHORIZED'` plus
`reason`, and the snapshot has `refused: { reason } | null` beside `status: 'closed'`. A
client with `reconnect` stops on a refusal, where it retried one for ever; `disconnect()`
then `connect()` starts over. In Chrome a refused peer saw `WT_SESSION_CLOSED`, because the
stream it opens fails before the close code arrives: a failed handshake now waits briefly for
the close and reports what it says. An `authorize` that throws is no longer a refusal: the
session closes without that code and stays retryable. `lastError` now says why a connected
session closed, where the close code was an error, and `peer.close(CloseCode.WT_UNAUTHORIZED,
reason)` refuses a live session the same way. A session whose handshake failed is no longer
left behind to swallow an `emit`.
