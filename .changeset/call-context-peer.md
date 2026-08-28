---
'transport-io': minor
---

`CallContext` gains `peer`, so a responder knows which peer called it. A call can now join its
own caller to a room or check that caller's permissions, which was impossible: the context was
`{ signal }` and a responder is registered on the server rather than on a peer, so every
authenticated request had to be hand-rolled as a pair of events. `CallContext` is now generic
over the map, defaulting to the registered one.
