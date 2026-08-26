---
'transport-io': patch
---

Four API promises now have code behind them: `handle()`'s disposer revokes the responder on
already-connected peers, a disconnected peer can no longer join a room, the handshake
deadline covers opening the emit stream rather than starting after it (and
`handshakeDeadlineMs` is a real `ClientOptions` field instead of an inert one), and an
aborted or timed-out `call()` rejects with `TransportError` code `WT_ABORTED` rather than a
raw DOMException.
