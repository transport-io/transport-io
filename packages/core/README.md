<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="https://raw.githubusercontent.com/transport-io/transport-io/main/assets/brand/transport-io-lockup-bone.svg">
    <img alt="transport-io" src="https://raw.githubusercontent.com/transport-io/transport-io/main/assets/brand/transport-io-lockup-ink.svg" width="340">
  </picture>
</p>

Real-time apps over WebTransport. Socket.IO's shape, on a transport with multiple streams
and datagrams, without Socket.IO's mistakes.

Framing, length prefixes, buffer accumulation, stream lifecycle and backpressure queues are
hidden. Reliability is not: an event declares `stream` or `datagram` in the contract, and
"this message may be dropped" is a property of your data that lives in the type system.

**Read [KNOWN-ISSUES.md](https://github.com/transport-io/transport-io/blob/main/KNOWN-ISSUES.md)
before you start.** It is what this library refuses to do and will not change, plus the one
measured defect. Full documentation is in the
[repository README](https://github.com/transport-io/transport-io#readme). The short version:

- **WebTransport only.** No WebSocket fallback, deliberately - a fallback would silently
  make the datagram lane reliable and ordered, which is a lie about your data.
- **Chrome and Firefox.** Safari cannot talk to a quiche-backed server and is unsupported.
- **The server needs a separate native install**, and its Linux prebuild needs glibc 2.38 -
  no default Node `-slim` image has it, and Alpine has no prebuild at all.
- **Each `call()` leaks ~5.95 KB of server memory**, upstream in the QUIC binding, not in
  this library. `emit` and datagrams are flat.
- **The protocol is v0 and unstable.** Both sides currently require an exact match.

```bash
npm install transport-io
```

A git install does not work - the repository root is a private monorepo package.

MIT © #V0ID
