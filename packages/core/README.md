<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="https://raw.githubusercontent.com/transport-io/transport-io/main/assets/brand/transport-io-lockup-bone.svg">
    <img alt="transport-io" src="https://raw.githubusercontent.com/transport-io/transport-io/main/assets/brand/transport-io-lockup-ink.svg" width="340">
  </picture>
</p>

Real-time apps over WebTransport. Socket.IO's shape, on a transport with multiple streams
and datagrams. Two lanes, one contract, no fallback.

Framing, length prefixes, buffer accumulation and stream lifecycle are handled for you. An
event declares `reliable` or `unreliable` in the contract, so "this message may be dropped"
is visible in the type system. The reliable lane is carried on QUIC streams, the unreliable
lane on QUIC datagrams.

A request answers with a value or with a sequence. `call()` awaits one result. `stream()`
returns an async iterable, and leaving the loop resets the QUIC stream so the server
generator's `finally` runs.

**Read [KNOWN-ISSUES.md](https://github.com/transport-io/transport-io/blob/main/KNOWN-ISSUES.md)
before you start.** It lists what this library will not do, and the one measured defect. Full documentation is in the
[repository README](https://github.com/transport-io/transport-io#readme). The short version:

- **WebTransport only.** No WebSocket fallback, deliberately - a fallback would silently
  make the unreliable lane reliable and ordered, which is a lie about your data.
- **Chrome and Firefox.** Safari cannot talk to a quiche-backed server and is unsupported.
- **The server needs a separate native install**, and its Linux prebuild needs glibc 2.38 -
  no default Node `-slim` image has it, and Alpine has no prebuild at all.
  That package, the fourteen-day ECDSA rule for a pinned development certificate, and the
  Safari gap are the same for Socket.IO's WebTransport transport: properties of the stack,
  not of this library.
- **Each bidirectional stream leaks ~5.95 KB of server memory**, upstream in the QUIC
  binding, not in this library. `emit` and datagrams are flat. The leak is per stream rather
  than per message, so a `stream()` of a thousand tokens costs 5.95 KB in total where a
  thousand `call()`s cost 5.95 KB each: for token workloads, streaming is the cheap shape.
- **The protocol is v0 and unstable.** Both sides currently require an exact match.

```bash
npm install transport-io
```

A git install does not work - the repository root is a private monorepo package.

MIT © #V0ID
