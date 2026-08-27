<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="assets/brand/transport-io-lockup-bone.svg">
    <img alt="transport-io" src="assets/brand/transport-io-lockup-ink.svg" width="340">
  </picture>
</p>

Real-time apps over WebTransport. Socket.IO's shape, on a transport with multiple streams
and datagrams, without Socket.IO's mistakes.

**Hide the mechanism, expose the guarantee.** Framing, length prefixes, buffer
accumulation, stream lifecycle and backpressure queues are hidden - nobody should ever
write framing code. Reliability semantics are always visible: "this message may be
dropped" is a property of your data, not an implementation detail, and it lives in the
type system.

```ts
import { defineContract } from 'transport-io'
import { z } from 'zod'

export const teaser = defineContract({
  chat: { lane: 'stream', payload: z.object({ room: z.string(), body: z.string() }) },
  cursor: { lane: 'datagram', payload: z.object({ x: z.number(), y: z.number() }) },
})
```

`chat` will arrive. `cursor` may not. The contract is the only place that says so, and
both sides infer from it.

---

## Read this before you install

These are properties of the library, not caveats to grow out of. If any of them is
disqualifying, stop here - that is the point of putting them first.

### Chrome and Firefox only

Safari ships WebTransport and still cannot talk to a server built on this stack. It waits
for session-level flow-control SETTINGS that the underlying QUIC library does not send, so
feature detection reports success, the session establishes, and then no application bytes
ever flow. That is the worst failure mode available, which is why the client turns it into
a named error with a deadline rather than hanging. Safari is unsupported until the fix
lands upstream.

### There is no fallback

Not to WebSocket, not to anything. A WebSocket is reliable and ordered, so falling back to
one would silently convert every `lane: 'datagram'` event into a reliable one - your
contract would still say the message may be dropped while the transport guaranteed it
never is. Degrading availability is honest. Degrading a guarantee is not. An unsupported
runtime gets `WT_NO_SUPPORT` and nothing else.

### Reconnect creates a new session

A reconnection is a new session with a new identity. Room membership does not survive it,
and pending calls reject. Re-establishing authentication and resubscribing is your job -
the library gives you the primitive and the hook, because whether a call was executed
before the connection dropped is unknowable from the client, and pretending otherwise
means silently risking duplicate execution.

### Datagrams may be dropped, duplicated or reordered

On the datagram lane there is no delivery guarantee, no ordering guarantee, no
acknowledgement, no retransmission, and no flow-control feedback. Duplicates are discarded
for you and stale arrivals are dropped rather than rendered as history, but loss is
reported to nobody because loss is the contract. Anything that cannot tolerate this belongs
on the stream lane, and the contract is where you say which.

### It requires raw UDP ingress to your process

On the port you listen on. Unlike TCP, many managed platforms do not provide this. Verify
your platform routes UDP before building on this library - it is the first thing to check
when nothing connects, and no amount of application code works around it.

### The emit lane blocks across rooms

All rooms share one emit stream per direction, so a high-volume room delays a quiet room's
messages to the same peer. Calls and datagrams are fully isolated - they use separate
streams and separate packets - but emits to one peer are serialised across every room that
peer belongs to. Per-room lanes are reserved as a negotiated feature and are not in this
version. Do not read "independent streams" as a promise about emits.

### Each call leaks memory, upstream

Every `call()` opens its own bidirectional stream, and the QUIC binding this library ships
against leaks roughly **5.95 KB of server memory per stream**, unbounded. At ten calls per
second that is about 209 MB an hour. It is not this library's leak - the same code over an
in-memory transport costs 0.045 KB per call, and the binding leaks the same amount with
none of this library's code present - but it is what you get if you deploy this today.

It is reported upstream. An alternative transport measures flat on the same benchmark and
is wired up behind an internal seam, but it cannot shut a server down gracefully and does
not deliver call cancellation to the responder, so it is not the default yet.

If your workload is mostly `emit` and datagrams, this does not affect you: both are flat,
and you can check that yourself rather than taking it on trust - `npm run soak:lanes` runs
the memory soak over those two lanes only, and it is expected to pass.

### Protocol versioning

The handshake carries a version. **A major mismatch refuses the session; the minor surface
is the intersection of both sides' feature lists**, so older peers keep working and newer
ones light up extras. Adding or removing an event is a rolling-deploy-safe change, because
event identity is derived from the event's name rather than its position. Changing an
event's lane is breaking and is refused at connect, by design: it changes a guarantee.

**The protocol is v0 and unstable.** Both sides currently require an exact match. The
negotiation mechanism exists; the compatibility promise does not, and will not until the
first stable release.

### The package is `0.x`, and a minor bump may break you

The first publish is `0.1.0`. Under `0.x` a **minor** bump is allowed to contain breaking
changes - pin an exact version, or accept that `^0.1.0` can move under you.

Every breaking change still gets a version bump and a changelog entry; that rule is in force
from the first publish. What `0.x` withholds is the promise that a minor bump is safe, and
that promise is withheld deliberately: `call()` ships with a documented upstream leak, and a
single audit shortly before the first release found thirty-one defects worth fixing first.
That is not an API anyone should treat as settled yet. See D83.

---

## Install

```bash
npm install transport-io
```

A git install does **not** work, and it is worth saying why rather than letting you find
out: this is a monorepo whose root package is `transport-io-monorepo` and is `private`, so
`npm install github:transport-io/transport-io` installs that root and `import … from
'transport-io'` then fails. Verified, not assumed. To work on the library instead, clone it:

```bash
git clone https://github.com/transport-io/transport-io
cd transport-io && npm install && npm run build
```

The server also needs the native QUIC transport, which is a **separate, deliberate
install**:

```bash
npm install @fails-components/webtransport-transport-http3-quiche
```

It is not a dependency of anything, only a dynamic import, so no package manager will pull
it in for you. Browsers need nothing extra - they use the platform's own WebTransport.

Two things about that native package are worth knowing before CI surprises you:

- **Its prebuilt binaries come from GitHub Releases, not npm.** A registry mirror alone is
  not enough. Pin the version exactly and cache the download.
- **The Linux prebuild needs glibc 2.38.** Every default Node slim image is currently
  byte-identical to its Debian bookworm variant, which ships glibc 2.36 and will not load
  it. Use a `trixie` variant or Ubuntu 24.04. There is no musl build at all, so Alpine
  falls back to a source compile.

**Consumers** need Node 22 or newer, and TypeScript 5.0 or newer - gated by `const` type
parameters in the public types, and checked in CI.

**Contributors** additionally need [Bun](https://bun.sh) and `openssl` on `PATH`. Bun runs
the unit tests, the documentation gate and the example build; `openssl` mints the
short-lived certificate the browser needs for WebTransport. Neither is optional: `npm
install` succeeds without Bun and then the first `git commit` fails, because the hooks shell
out to it. Development is supported on macOS and Linux only - Windows contributors should
use WSL.

## Use

```ts standalone
// contract.ts - the whole surface, in one file
import { defineContract, type MapOf, type$ } from 'transport-io'

export const contract = defineContract({
  chat:   { lane: 'stream',   payload: type$<{ from: string; body: string }>() },
  cursor: { lane: 'datagram', payload: type$<{ x: number; y: number }>() },
  save:   { lane: 'stream',   payload: type$<{ text: string }>(),
            returns: type$<{ revision: number }>() },
})

export interface AppMap extends MapOf<typeof contract> {}
```

Write both lines. The second is what keeps every hover readable - with it, hovering `emit`
shows 126 characters; without it, 303, including your validator's internals.

```ts
// server
import { createServer } from 'transport-io'

export async function serve(): Promise<void> {
  const server = createServer<AppMap>({ contract })
  await server.listen()

  server.handle('save', async ({ text }) => ({ revision: text.length }))

  server.onSession((peer) => {
    void peer.join('lobby')
    peer.on('chat', (msg) => void server.to('lobby').emit('chat', msg))
    peer.on('cursor', (pos) => void server.to('lobby').except(peer.id).emit('cursor', pos))
  })
}
```

```ts
// client
import { Client } from 'transport-io'
import { connectBrowser } from 'transport-io/browser-transport'

export async function run(url: string): Promise<number> {
  const client = new Client<AppMap>({ contract, connect: () => connectBrowser({ url }) })
  await client.connect()

  client.emit('chat', { from: 'me', body: 'hello' }) // arrives
  client.emit('cursor', { x: 12, y: 40 }) // may not
  const { revision } = await client.call('save', { text: 'hi' })
  return revision
}
```

A wrong event name or payload fails to compile, and the error names the event rather than
unrolling the contract type.

## What is different

**Acknowledgements are streams, not bookkeeping.** Each `call` opens its own bidirectional
stream: write the request, half-close to end it, read until the peer closes. The stream
*is* the correlation, so there are no acknowledgement identifiers, no pending-callback map
and no timeout tracking - and a stalled call cannot block another one. Cancellation is a
QUIC stream reset: immediate, costing no application message, and the responder's signal
fires without the client sending anything.

**No default call timeout.** A dead peer is detected by the QUIC idle timeout, which
rejects every pending call - the case a timeout is usually reached for is already handled.
Pass `AbortSignal.timeout(ms)` when you want one.

**A documented wire protocol.** [`PROTOCOL.md`](PROTOCOL.md) is written so someone can
implement an interoperable server in another language without reading this source. Socket.IO's
real sin was an undocumented protocol only its own client could speak.

**Batteries included, no infrastructure.** `MemoryAdapter` is the default, so `npm install`
and run. If you write your own adapter, `transport-io/testing` exports `HostileAdapter`,
which serialises frames through bytes, adds latency, reorders, duplicates and fails on
command - because an adapter that only passes against an in-memory map has not been tested
against anything.

## Not in this version

Namespaces (a room-name prefix covers it), presence and peer counts, middleware chains
(auth is one hook), binary payloads (JSON only, with a codec seam reserved), `stream()` for
token streaming (the protocol space is reserved and `AbortSignal` already works), framework
bindings, and the Redis adapter.

## Documentation

- [`PROTOCOL.md`](PROTOCOL.md) - the wire format
- [`API.md`](API.md) - the TypeScript surface
- [`DECISIONS.md`](DECISIONS.md) - every question this project raised, answered
- [`ADR/`](ADR) - the records a future contributor would want to reverse
- [`examples/chat`](examples/chat) - both lanes in one page

## Licence

MIT
