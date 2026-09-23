---
'@transport-io/devtools': patch
---

Copy rows puts `lastError` in its header, on a line of its own between the connection and
the counters: the code, what was thrown or, with no cause, what the error says, and the
remedy. `no lastError` when there is none, so the header is three lines every time.
`formatRows` produces the same text.
