---
'transport-io': minor
---

Lane values are renamed for what they guarantee: `lane: 'stream'` becomes `lane: 'reliable'`
and `lane: 'datagram'` becomes `lane: 'unreliable'`. Breaking, and it touches the wire: the
handshake carries the lane as a literal string, so a 0.1.0 peer and a 0.2.0 peer refuse each
other with `WT_PROTOCOL_ERROR`.

`stream` and `datagram` named the mechanism. This library's whole position is that the
mechanism is hidden and the guarantee is exposed, and the lane was the one place saying
otherwise. No error code changed: `WT_TOO_MANY_STREAMS` and `WT_DATAGRAM_TOO_LARGE` really
are about QUIC streams and datagrams. See D92.
