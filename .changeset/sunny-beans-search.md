---
'transport-io': patch
---

Every error code PROTOCOL.md §10 defines is now either transmitted by a real code path or
deleted. Handshake refusals close with 1000/1001 instead of a blanket 1004; a reliable-only
session closes with 1006 rather than vanishing; inbound call streams above the cap are reset
with code 9 before the request is read. Reset codes 2–8 are removed: call failures were
already reported as CALL_ERROR frames carrying a code and a message, which is strictly more
than a one-byte reset can express.
