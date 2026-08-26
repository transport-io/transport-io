---
'transport-io': minor
---

Add call() with AbortSignal-to-stream-reset and the concurrent stream cap. Fix the
datagram flush to be coalesced rather than synchronous, which made the bounded ring and
the TTL reachable, and add tests that force loss, duplication, reordering and both drop
causes deliberately.
