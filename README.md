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

## Install

```bash
npm install transport-io
```

Installing from git does not work. The repository root is a private package called
`transport-io-monorepo`, so `npm install github:transport-io/transport-io` installs that
instead and `import … from 'transport-io'` fails. To work on the library itself, clone it:

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

- [`KNOWN-ISSUES.md`](KNOWN-ISSUES.md) - **read this before you start**: what this library
  refuses to do and will not change, plus the one measured defect
- [`PROTOCOL.md`](PROTOCOL.md) - the wire format
- [`API.md`](API.md) - the TypeScript surface
- [`DECISIONS.md`](DECISIONS.md) - every question this project raised, answered
- [`ADR/`](ADR) - the records a future contributor would want to reverse
- [`examples/chat`](examples/chat) - both lanes in one page

## Licence

MIT, for the source code.

The name and the marks in [`assets/brand`](assets/brand) are **not** covered by it.
Copyright and trademark are separate, and MIT speaks only to the first, so the carve out is
stated in [`assets/brand/LICENSE`](assets/brand/LICENSE). Short version: use the marks to
refer to this project, not as the mark of your own. Forking is welcome, under your own
name.
