---
'transport-io': patch
---

`Adapter` now declares `nodeId`, and the hub dedupes remote envelopes against it rather than
against the server's separately-configured id — where those differed, every local broadcast
was delivered twice. `MemoryAdapter` and `HostileAdapter` accept a shared `memoryBus()` so a
single process can model several nodes, which is what made the cross-node path testable at
all. `call()` also refuses an event that declares no `returns` by name, instead of failing at
the responder as a missing handler.
