---
'transport-io': minor
---

An unreliable event can declare what it accepts on a transport that carries the reliable lane
only: `unreliable(payload, { fallback: 'newest' })`, carried in order with the oldest and the
stale dropped at the sender as the datagram ring drops them. `withFallback` on the client and
`server.withFallback` on the server accept a fallback connector only when every unreliable
event in the contract has declared one; otherwise the line fails to compile and names the
event. A `FallbackClient` has no `call()` or `stream()`; they live on `native`, `null` on a
fallback session. A session on a fallback transport whose contract has an undeclared
unreliable event is refused with `WT_RELIABILITY_REFUSED` before the handshake. `ClientState`
gains `transport` and `fallbackReason`, and `ServerPeer` gains `transport`.
