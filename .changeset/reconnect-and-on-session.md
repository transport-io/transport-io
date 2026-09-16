---
'transport-io': minor
---

`client.onSession(cb)` runs once for every session the client gets, the first and each one
a reconnect produces, with the snapshot as it connected. `new Client({ reconnect: { minMs,
maxMs } })` reconnects on its own after a connected session closes, with a wait that doubles
from `minMs` to `maxMs` on each failed attempt and is randomised; off unless given, every
attempt starting from the native connector, the first `connect()` never retried, and
`disconnect()` stopping it. A reconnect is still a new session.
