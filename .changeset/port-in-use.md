---
'transport-io': patch
---

A port another process holds is refused before anything binds, as `WT_PORT_IN_USE` naming
the port. `listenHttp3` probes its UDP port, because the QUIC binding binds a held port
without a word and the server then never hears a session; `listenWebSocket` and the dev
command report the same code for a held TCP port, and the dev command checks both loopback
addresses, since a server on `::` alone lets `127.0.0.1` bind beside it.
