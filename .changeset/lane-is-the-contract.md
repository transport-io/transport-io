---
'transport-io': patch
---

A datagram event can no longer be called. `{ lane: 'datagram', returns }` is now a type
error, and the runtime refuses at all three points where the lane could be subverted:
`call()`, `handle()`, and an inbound CALL_REQUEST from a peer that is not bound by our types.
