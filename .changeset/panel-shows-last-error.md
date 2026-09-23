---
'@transport-io/devtools': patch
---

The status line shows `lastError`: its code always, beside the status, and what was thrown
and the remedy when the code is clicked. It follows the snapshot, so the next attempt clears
it. A failed connect read as `closed` with nothing beside it, which is what a page that shows
`status` and not `lastError` saw when a page that was not a secure context could not connect.
