---
'transport-io': patch
---

`transport-io dev` prints the address it binds, `http://127.0.0.1:<port>`, rather than
`localhost`, which a browser may resolve to `::1`. With no static directory it prints the
manifest URL a page served elsewhere needs proxied, instead of a page URL that serves
nothing.
