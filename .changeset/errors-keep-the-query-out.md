---
'transport-io': patch
---

An error never prints the query of the URL it dialled. A failed handshake's message named the
whole URL, and the query is where a token travels, so `lastError.message` in a log, an error
tracker or a page carried the credential. It now names the origin and the path, on both
connectors. The errors page says which fields are for branching, `code` and a refusal's
`reason`, and which are for logs, `message`, `remedy` and `cause`: nothing on an error is
written for a user, and there is no shorter field to print instead.
