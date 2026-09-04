---
'transport-io': patch
---

`npx transport-io` ran nothing. npm links the `bin` as a symlink, and the entry guard compared
`process.argv[1]`, which keeps the link, with `import.meta.url`, which is the target, so the
command exited 0 without a line of output. It printed its usage only when run as
`node node_modules/transport-io/dist/cli/main.node.js`, which is how every test ran it. The
guard now compares real paths, and a test runs the CLI through a symlink.
