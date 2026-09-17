---
'transport-io': patch
---

`transport-io dev` checks its WebTransport port before it starts or prints anything. With no
server entry it bound nothing on that port and checked nothing, so with another process
holding UDP 4433 it printed `webtransport https://127.0.0.1:4433/` for a server that was not
its own. It now exits with `WT_PORT_IN_USE`, as the demo and `listenDev` already did.
