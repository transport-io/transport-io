---
'transport-io': minor
---

The emit lane over a WebSocket, as the one fallback transport. `connectWebSocket` from
`transport-io/websocket-transport` is the connector for `withFallback`, and `listenWebSocket`
from `transport-io/websocket-node-transport` is the listener for `server.withFallback`, over
`ws`, an optional peer. It carries emits both ways and unreliable events that declare
`fallback: 'newest'`, wrapped in a `DATAGRAM` frame on the emit lane; `call()` and
`stream()` fail there with `WT_LANE_UNAVAILABLE`, which `FallbackClient` makes unreachable
in TypeScript. The sink polls `bufferedAmount` so the emit queue's bound is reachable on a
browser socket. The listener answers the probe that reports `WT_UDP_UNREACHABLE`.
