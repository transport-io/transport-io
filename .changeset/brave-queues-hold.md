---
'transport-io': patch
---

The emit backpressure bound is reachable again. A frame now leaves the emit queue when its
write completes rather than when it is handed to the transport, so queue depth measures real
backlog, `WT_PEER_TOO_SLOW` fires, and a peer that stops reading is disconnected instead of
accumulating unboundedly in a promise chain. A rejected write on the emit stream closes the
session per PROTOCOL.md §5.5 instead of being discarded.
