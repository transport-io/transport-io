---
'@transport-io/react': patch
---

`useStream`'s `stop()` now moves the state to `done`, holding what had arrived. It cancelled
the stream on the wire and left the state at `streaming`, so a stop button rendered on that
status stayed on screen and anything waiting for `done` waited forever. Found by the e2e for
`examples/react`.
