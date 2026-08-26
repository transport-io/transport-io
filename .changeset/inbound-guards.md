---
'transport-io': patch
---

Two inbound guards the spec described and the code did not have. The frame payload cap is now
chosen by frame type — an EMIT frame declaring 16 MiB against its documented 1 MiB cap is
refused before any of it is buffered — and a datagram arriving before the handshake is
discarded rather than decoded and delivered to the application.
