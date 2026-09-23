---
'transport-io': patch
---

An `onSession` callback that throws now ends the session it was given. `connect()` already
rejected and the status already said `closed`, but the session stayed open and `emit` still
reached the server. Now the session is closed, with the reason `session setup failed`, and
`lastError` has what was thrown on `cause`.
