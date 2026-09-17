---
'transport-io': patch
---

A connection that is lost, not closed, is noticed. The browser and reference transports
passed the platform's rejected `closed` across the seam, so a page whose server was killed
said `connected` for as long as anyone watched, never reconnected, and left two rejections
unhandled. `closed` now resolves however a connection ends; a lost one reports code `0` and a
reason beginning `connection lost`. The WebSocket mapping no longer reports the socket's own
close codes as session codes, where a lost socket's 1006 read as `WT_RELIABILITY_REFUSED`.
A session from `listenHttp3` or `listenDev` sends an empty datagram every 15 s, because the
reference binding never gave up on a silent peer: a killed client stayed in its rooms on a
server that sent nothing, and is now gone within about 25 s. A client that fails its opening
handshake no longer ends the listener's accept loop. The parity suite kills a peer with no
close handshake, in both directions, on every transport.
