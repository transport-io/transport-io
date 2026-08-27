---
'transport-io': patch
---

A disposed session now releases everything it owns: both lane queues, the per-peer duplicate
suppression and sequence state, and the responses still in flight. It also stops accepting
emits rather than queueing them into a queue that will never drain, which the hub could
trigger by broadcasting to a room containing a peer that had just died. See D96.
