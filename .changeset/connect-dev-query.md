---
'transport-io': minor
---

`connectDev({ query })` and `devClient({ query })` add a query to the WebTransport URL, which
is where a listener's `authorize` reads a token and which a page could not reach, since the
URL comes from the dev manifest. An object, a `URLSearchParams`, or a function returning
either; the function is called on every attempt, so a token refreshed since the last one is
the one sent. `fetchDevManifest()` is exported from `transport-io/dev-transport`: the fetch
`connectDev` makes, with the same loopback refusals, for tooling that wants the hash or the
URL without connecting.
