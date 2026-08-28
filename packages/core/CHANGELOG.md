# transport-io

## 0.3.0

### Minor Changes

- Export `StreamResult` and `StreamableOf`. `stream()` returns the first and constrains on the
  second, so without them a consumer could not name the return type of 0.2.0's headline
  feature or write a function taking one. `CallableOf` was exported and its streaming twin was
  not.

  Found by deriving the TypeScript floor gate's probe from the shipped declarations instead of
  hand-listing five exports out of forty-eight. See D98.

## 0.2.1

### Patch Changes

- 0abd982: The package README now mentions `stream()`, and states the upstream 5.95 KB leak as per
  bidirectional stream rather than per `call()` - so a reader can see that a thousand streamed
  tokens cost what one call does, instead of concluding that every request leaks.

## 0.2.0

### Minor Changes

- 975cfa8: Lane values are renamed for what they guarantee: `lane: 'stream'` becomes `lane: 'reliable'`
  and `lane: 'datagram'` becomes `lane: 'unreliable'`. Breaking, and it touches the wire: the
  handshake carries the lane as a literal string, so a 0.1.0 peer and a 0.2.0 peer refuse each
  other with `WT_PROTOCOL_ERROR`.

  `stream` and `datagram` named the mechanism. This library's whole position is that the
  mechanism is hidden and the guarantee is exposed, and the lane was the one place saying
  otherwise. No error code changed: `WT_TOO_MANY_STREAMS` and `WT_DATAGRAM_TOO_LARGE` really
  are about QUIC streams and datagrams. See D92.
- 5d66096: `stream()`: an event declaring `yields` instead of `returns` answers with a sequence. The
  client gets an async iterable with a `collect()`, the server writes an async generator.
  Leaving the loop with `break` resets the QUIC stream, which fires the handler's `ctx.signal`
  and runs its `finally`, so cancellation costs no extra API.

  Adds one frame type, `CALL_CREDIT`. A streaming responder may run at most 32 frames ahead of
  what the consumer has taken, because the transport's own flow control turned out to apply
  none: measured on the reference binding, a producer ran 136,523 frames and roughly 53 MB
  ahead of a consumer that had taken 40. A streaming initiator therefore keeps its send side
  open rather than half-closing after the request.

  `call()` is unchanged and a 0.1.0 caller still works against a 0.2.0 responder. See ADR 0012
  and D93.

### Patch Changes

- 19133e7: A disposed session now releases everything it owns: both lane queues, the per-peer duplicate
  suppression and sequence state, and the responses still in flight. It also stops accepting
  emits rather than queueing them into a queue that will never drain, which the hub could
  trigger by broadcasting to a room containing a peer that had just died. See D96.
- da8a894: Documentation correction: `emit` hover is 107 characters with the two-line contract pattern
  and 353 without it, for the README's contract. The previously published numbers, 126 and 303,
  were wrong and nothing measured them. `scripts/check-hover.ts` now drives `tsc --lsp --stdio`
  and measures the real hover string on every CI run. See D94.
- df8d351: A streaming responder parked waiting for credit is now released when its session ends.
  Previously it waited for ever, holding one of the session's 256 stream slots and whatever its
  handler had open, because `dispose()` cleared handlers without aborting the responses in
  flight. Nothing in the credit scheme can tell a slow consumer from a departed one, so session
  liveness has to. See D95.

## 0.1.0

### Minor Changes

- First release. `0.0.1` was published from the same tree to claim the name on the registry,
  carries no release notes, and was never meant to be used.

  One runtime-visible change since that publish: `TransportError.message` separates the remedy
  with a hyphen rather than an em dash, so the shape to match on is `code: message - remedy`.
  Everything else since is documentation, brand assets and comments.

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
