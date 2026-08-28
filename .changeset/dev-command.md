---
'transport-io': minor
---

`npx transport-io dev`: one command for the first thirty minutes. It mints the pinned
certificate, computes its hash, serves it at `/.well-known/transport-io-dev`, serves the built
package as ESM, and hands the certificate to your server process by environment. `--demo`
serves a two-tab chat page out of the package and writes no files.

Two functions connect to it: `listenDev()` from `transport-io/node-transport`, and
`connectDev()` from the new `transport-io/dev-transport`. `connectDev` refuses any page origin
or WebTransport URL that is not loopback, so it cannot reach production by accident.

The CLI adds no runtime dependencies: it uses only Node built-ins, and an import-boundary rule
enforces that. It does not bundle browser code.
