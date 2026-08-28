---
'transport-io': patch
---

A streaming handler no longer needs `ctx.signal.throwIfAborted()` in its loop. The responder
checks the signal before asking the generator for another value, so a cancelled stream stops
without the handler repeating that check. `throwIfAborted()` remains the escape hatch for a
handler doing long work between yields, where nothing else can interrupt it.
