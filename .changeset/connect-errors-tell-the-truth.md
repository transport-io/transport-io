---
'transport-io': patch
---

Whatever is thrown between `connect()` and the handshake now lands in `lastError` as what it
is. A throw that is not a `TransportError` still arrives as `WT_SESSION_CLOSED`, but with what
was thrown on `cause`, where it was dropped, and a remedy that points at `cause` instead of
saying "Retry the connection.", which retried a `TypeError` into the same `TypeError`. A
subscriber that throws on the attempt's first state change no longer leaves the status at
`connecting` with no `lastError`. An attempt superseded by `disconnect()` and a newer
`connect()` no longer writes its failure over the newer attempt, and no longer clears it, so a
third `connect()` joins the attempt in flight instead of starting another.
