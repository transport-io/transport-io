---
'transport-io': patch
---

`ServerPeer` and `RoomTarget` default to the registered map, as `Client` and `Server` already
did. A bare `ServerPeer` annotation previously meant `AnyMap`, which accepts every event name
and every payload, so registering a contract and then annotating a peer bought nothing.
