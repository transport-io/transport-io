# transport-io

## 0.1.0

### Minor Changes

- b52a4fd: Add call() with AbortSignal-to-stream-reset and the concurrent stream cap. Fix the
  datagram flush to be coalesced rather than synchronous, which made the bounded ring and
  the TTL reachable, and add tests that force loss, duplication, reordering and both drop
  causes deliberately.
- cb4d215: Add README, AGENTS.md and CHANGELOG. Run the memory soak: it fails on an unbounded
  upstream leak of 11.6 KB per bidirectional stream, which blocks Stage 1.
- 9e116da: Add Playwright end-to-end against real Chromium and real QUIC, with the chat example as
  the fixture so it cannot rot.
- 0ebe240: Add browser and node transport entry points, and the chat-with-live-cursors example
  exercising both lanes and a call from a real browser.
- f2adbc6: Add HostileAdapter and the adapter conformance suite, exported from transport-io/testing
  so third-party adapters can run the same tests core does.
- 9ee563f: Handshake as frame 0 of the emit stream, both lanes, rooms and hub. Two clients in one
  room can exchange a message on each lane.
- 0e8e352: Wire the reference WebTransport implementation behind the transport seam, and prove the
  milestone over real QUIC: two clients in one room exchanging a message on each lane.

### Patch Changes

- 3d81e17: Four API promises now have code behind them: `handle()`'s disposer revokes the responder on
  already-connected peers, a disconnected peer can no longer join a room, the handshake
  deadline covers opening the emit stream rather than starting after it (and
  `handshakeDeadlineMs` is a real `ClientOptions` field instead of an inert one), and an
  aborted or timed-out `call()` rejects with `TransportError` code `WT_ABORTED` rather than a
  raw DOMException.
- 3311f5a: The emit backpressure bound is reachable again. A frame now leaves the emit queue when its
  write completes rather than when it is handed to the transport, so queue depth measures real
  backlog, `WT_PEER_TOO_SLOW` fires, and a peer that stops reading is disconnected instead of
  accumulating unboundedly in a promise chain. A rejected write on the emit stream closes the
  session per PROTOCOL.md §5.5 instead of being discarded.
- 03fd411: Documentation reconciled with the implementation in both directions. Withdrawn: per-event
  datagram TTL and `ttl: null`, which `EventDef` never grew and `DatagramQueue` could not
  accept; and the instruction to gate session establishment behind authentication, in a library
  that exposes no peer identity and has no reject hook. Corrected: the event id width in the
  decision ledger and ADR 0010 still said two bytes against a four-byte wire, and §7.3 argued
  for a hashed Origin eighty lines after establishing that Origin is allocated.
- 5b20dc8: Two defects a fresh clone found and a working checkout could not. `npm run e2e` now builds the
  library before the example, which imports it through its exports map and could not resolve it
  in a clone where `dist` had never been built. And the install instructions no longer offer a
  git install: the repository root is a private monorepo package, so `npm install
  github:owner/repo` installs that root rather than the library.
- bdb1adf: `Adapter` now declares `nodeId`, and the hub dedupes remote envelopes against it rather than
  against the server's separately-configured id - where those differed, every local broadcast
  was delivered twice. `MemoryAdapter` and `HostileAdapter` accept a shared `memoryBus()` so a
  single process can model several nodes, which is what made the cross-node path testable at
  all. `call()` also refuses an event that declares no `returns` by name, instead of failing at
  the responder as a missing handler.
- 165ac23: Every gate was fed an empty input set and six passed, because an aggregate over nothing is
  inside every bound. All six now fail loudly: the norms, workflow, boundary and documentation
  gates carry explicit floors, and `knip` and `attw` - which cannot be taught this from the
  inside - are fronted by a check that their inputs are non-empty. The three unproven normative
  statements are now zero: two were provable, and the third turned out to be a real defect,
  since nothing stopped `call()` opening a stream on a closed session.
- 2e01d45: `Session.close()` is idempotent in both halves. `dispose()` already was, but the underlying
  `conn.close()` was not, so a client disconnecting while the server tore the same session down
  - ordinary, and constant under load - reached the transport twice. quiche logged
  "WebTransportHttp3 close sent twice" and refused the extra call; a 60-minute soak produced
  865,464 of those lines, which was loud enough to bury the soak's own output.
- 93daf40: Two inbound guards the spec described and the code did not have. The frame payload cap is now
  chosen by frame type - an EMIT frame declaring 16 MiB against its documented 1 MiB cap is
  refused before any of it is buffered - and a datagram arriving before the handshake is
  discarded rather than decoded and delivered to the application.
- cb5af26: A datagram event can no longer be called. `{ lane: 'datagram', returns }` is now a type
  error, and the runtime refuses at all three points where the lane could be subverted:
  `call()`, `handle()`, and an inbound CALL_REQUEST from a peer that is not bound by our types.
- a9d8d75: Fix ctx.signal never firing on the responder when a caller aborts. Add a moq transport
  behind the seam and a per-transport parity suite; record why moq is not yet adoptable.
- 8bba7eb: Normative prose is gated. Every MUST in PROTOCOL.md and every bold guarantee in API.md now
  carries an identifier naming a test that mentions it back, checked from both ends. Writing a
  promise with no implementation now costs either a test or an explicit, counted admission -
  three statements are recorded as unproven, one of which this found: nothing sends more than
  one CALL_RESPONSE, so D7's multi-frame response shape is reserved and unexercised.
- f4c8c9f: The package is now shippable: an MIT LICENSE file exists (it was declared in package.json
  and present nowhere, so GitHub detected no licence and granted no rights), the tarball
  carries a README and the licence rather than `dist` alone, and `RemoteEnvelope` - required to
  implement the `Adapter` interface - is exported. The install instructions no longer point at
  an unpublished npm name, and AGENTS.md is compiled by the documentation gate, which
  immediately caught two broken snippets in it.
- 4733043: Teardown no longer leaks. A Session is disposed when its connection closes rather than only
  when this side initiates the close, so the sweep interval - and the whole object graph its
  callback retained - is released on every disconnect. An adapter rejection during teardown no
  longer abandons the remaining rooms or surfaces as an unhandled rejection, and a rejected
  join no longer leaves a peer receiving traffic for a room it was refused.
- 6dd7405: Attribute the per-stream leak to both halves of the reference transport, measure the
  alternative transport as flat, and fix connectHttp3 to await the native import so a
  standalone Node client works.
- 1b6cbcc: The lane soak no longer passes on an empty sample set. A run shorter than its own warmup
  collected no samples, and with none the fitted slope was 0 and the peak RSS was `-Infinity` -
  both inside their bounds - so it printed `SOAK PASSED` having measured nothing. It now
  requires at least three samples and says so when it does not have them.
- 16c43cc: Every error code PROTOCOL.md §10 defines is now either transmitted by a real code path or
  deleted. Handshake refusals close with 1000/1001 instead of a blanket 1004; a reliable-only
  session closes with 1006 rather than vanishing; inbound call streams above the cap are reset
  with code 9 before the request is read. Reset codes 2–8 are removed: call failures were
  already reported as CALL_ERROR frames carrying a code and a message, which is strictly more
  than a one-byte reset can express.
- 6e7fabe: The published tarball no longer ships the benchmarks. `dist/bench/*` - including a moq
  deadlock reproduction that imports a package consumers do not have - was 16 of 115 files.
- bae9a73: Depend on moq's per-platform native packages rather than a file path, root-cause its
  server-close deadlock, and record the decision to stay on the reference transport with the
  per-stream leak documented.
