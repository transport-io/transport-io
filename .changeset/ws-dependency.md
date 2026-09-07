---
'transport-io': patch
---

`ws` is a dependency of `transport-io`, so `listenWebSocket` needs no separate install. A
browser bundle that imports only the browser subpaths does not pull it in.
