# transport-io

Real-time apps over WebTransport. Socket.IO's shape, on a transport with multiple streams
and datagrams, without Socket.IO's mistakes.

Framing, length prefixes, buffer accumulation, stream lifecycle and backpressure queues are
hidden. Reliability is not: an event declares `stream` or `datagram` in the contract, and
"this message may be dropped" is a property of your data that lives in the type system.

**Full documentation, and the limitations you should read before installing, are in the
[repository README](https://github.com/v0id-user/transport-io#readme).** The short version:

- **WebTransport only.** No WebSocket fallback, deliberately — a fallback would silently
  make the datagram lane reliable and ordered, which is a lie about your data.
- **Chrome and Firefox.** Safari cannot talk to a quiche-backed server and is unsupported.
- **The server needs a separate native install**, and its Linux prebuild needs glibc 2.38 —
  no default Node `-slim` image has it, and Alpine has no prebuild at all.
- **Each `call()` leaks ~5.95 KB of server memory**, upstream in the QUIC binding, not in
  this library. `emit` and datagrams are flat.
- **The protocol is v0 and unstable.** Both sides currently require an exact match.

Not published to npm yet:

```bash
npm install github:v0id-user/transport-io
```

MIT © #V0ID
