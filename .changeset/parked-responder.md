---
'transport-io': patch
---

A streaming responder parked waiting for credit is now released when its session ends.
Previously it waited for ever, holding one of the session's 256 stream slots and whatever its
handler had open, because `dispose()` cleared handlers without aborting the responses in
flight. Nothing in the credit scheme can tell a slow consumer from a departed one, so session
liveness has to. See D95.
