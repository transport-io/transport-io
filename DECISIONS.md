# DECISIONS

Every question this project has raised, each one answered. There is deliberately no
open-questions file. A decision may be provisional, but it is never absent: where
certainty is impossible before implementation, the entry records a chosen default plus
the specific observable trigger that would make us revisit it.

Status: Phase 1a in progress. Entries below are settled unless marked OPEN.

---

## Part 1 — Fixed design decisions (from the kickoff, not relitigated)

| id | decision |
|----|----------|
| D1 | **lane-in-contract.** Events declare `stream` or `datagram` at contract-definition time. The lane is a property of the message type, never of the call site. |
| D2 | **streams-as-acks.** Each `call` opens its own bidirectional stream: write request, half-close to end it, read response until the peer closes. No correlation IDs, no pending-callback map, no ack bookkeeping. A stalled call cannot block another call. |
| D3 | **no-fallback.** WebTransport only. No WebSocket fallback, ever, because it would silently make the datagram lane reliable and ordered — a lie about the user's data. |
| D4 | **new-session-on-reconnect.** Reconnect creates a new session. Room membership does not survive it. `session` event carries `{ id, resumed }`; `resumed` is hardcoded `false` in v0.1 so real resume can arrive later as a `feat` flag rather than a redesign. |
| D5 | **adapter-boundary.** Pub/sub adapter interface. Frames cross it as bytes, never live objects. Every method is async. `PeerId` is a stable cross-process string. Core never assumes it knows a room's full membership. `MemoryAdapter` ships in core as the default; Redis is not in v1 and core must never reference it. |
| D6 | **abort-via-stream-reset.** `call()` and `stream()` take an `AbortSignal`; abort maps to a QUIC stream reset. Implemented in v0.1 even though `stream()` ships later. |
| D7 | **multi-frame-response.** A call response is a sequence of frames terminated by stream close, not one length-prefixed frame — so token streaming is addable without a protocol break. |
| D8 | **datagram-lane.** The unreliable lane uses WebTransport datagrams directly. |
| D9 | **serverless-publisher-split.** A write-only `Publisher` (broadcast only, stateless, constructible per invocation) is separated from the full `Adapter`. Session hosting requires a long-running process; that is not designable away. |

Non-goals for v0.1: namespaces, presence/peer counts, middleware chains, binary payloads
(JSON only, codec seam reserved), non-WebTransport transports, framework bindings
themselves, `stream()` and agent helpers, serverless session hosting, the Redis adapter.

---

## Part 2 — Phase 0 verified findings that became requirements

All of the following were verified on this machine or against shipped artefacts, not
relayed from documentation.

### F1. Install friction — smaller than feared, with two sharp edges
`npm install @fails-components/webtransport` is pure JS: 1s, 896K, no native code. The
native transport is a **separate, manually installed** package
(`@fails-components/webtransport-transport-http3-quiche`) loaded by dynamic `import()` —
it is not even an `optionalDependency`, so npm will never pull it in. Installing it took
6s and downloaded a prebuilt binary; no compilation.

- **Prebuilds come from GitHub Releases, not npm.** The dependency is on GitHub
  availability, not just the registry. Pin the transport version exactly and cache the
  download in CI. State this in README requirements — it is a supply-chain fact users
  deserve to know.
- Prebuild matrix is exactly five triplets: darwin-arm64, darwin-x64, linux-arm64,
  linux-x64, win32-x64. **No musl build**, so Alpine falls back to a source compile
  requiring git, cmake and a C++ toolchain.

### F2. glibc 2.38 — the default Docker tags are a trap
Parsing the ELF verneed table of the published linux-x64 prebuild gives
`libc.so.6 -> GLIBC_2.38` and `libm.so.6 -> GLIBC_2.38`. Debian 12 bookworm ships glibc
2.36; the binary will not load.

Docker Hub digests prove `node:24-slim`, `node:22-slim` and `node:lts-slim` are
**byte-identical to their bookworm variants**. Every default Node slim tag fails.

- Use `node:22-trixie-slim` / `node:24-trixie-slim` (glibc 2.41) or Ubuntu 24.04 noble
  (2.39). CI image must not be Alpine and must not be a default `-slim` tag.
- This goes in the **README as a warning**, not only in CI config, because every user who
  dockerises this hits the default tag first.

### F3. The dependency ships the fallback D3 forbids, on by default
`lib/webtransport.node.js` catches a failed QUIC connect and calls
`transportIntSwitchToReliable()`. There is an `Http2Server`, a
`reliability: 'unreliableOnly' | 'reliableOnly' | 'both'` option, and a full `lib/http2/`
implementation. Under HTTP/2 the datagram lane becomes reliable and ordered over TCP.
Safari additionally advertises its own H2 fallback "with the same API".

Disabling it is a hard requirement — see D10 for the enforcement rule.

### F4. Oversized and blocked datagrams are silently swallowed
Writing 1212B and 4844B against a 1211B `maxDatagramSize` both resolved with no error.
Source confirms why:

```js
const { code, message } = this.objint.writeDatagram(chunk)
if (code !== 'success' && code !== 'blocked' && code !== 'tooBig') { throw ... }
```

`tooBig` and `blocked` are both ignored. transport-io therefore owns **both** size
checking and backpressure accounting; the transport will never report either.

### F5. `WebTransportError` lacks the spec fields
On abort, the peer's read throws `WebTransportError: "Resetstream with code:0"` with
`err.streamErrorCode === undefined`. The reset code is recoverable only by parsing the
message string.

### F6. Stream reads do not preserve write boundaries
50 x 10B writes plus one 200,000B write arrived as **217 reads, largest chunk 1220 bytes**.
Small writes coincidentally survived as discrete reads; the large one shattered. This is
the worst case: naive boundary-trusting code passes in dev and fails under load. It is a
required test fixture, not a curiosity.

### F7. Bun segfaults on exit; Node does not
Identical smoke test, 3 runs each: Bun 1.3.11 passed every functional check then
segfaulted in native-addon teardown, 3/3. Node 20.20.2 crashed 0/3. This settles the
runtime split (D14).

### F8. Node's native QUIC is unusable and unshipped
Node landed QUIC (PR #62876, v26.2.0, 2026-05-19) but it has no `:protocol`
pseudo-header, no WebTransport datagram demultiplexing and no capsule framing, and
`--experimental-quic` is a **compile-time** flag defaulting off. Verified directly:
`quic.html` 404s on nodejs.org for v24 and v26, and `quic` is absent from the v26 module
index. Official binaries do not contain it. The runtime split is unaffected.

### F9. Browser support reached Baseline, but Chrome is now the laggard
Safari 26.4 shipped WebTransport 2026-03-24; WebTransport is Baseline 2026 at 89.96%
global usage. D3's stance is now defensible rather than reckless. However, per MDN
compat data:

| feature | Chrome | Firefox | Safari |
|---|---|---|---|
| `requireUnreliable` option | **no** | 114 | 26.4 |
| `session.reliability` | **no** | 114 | 26.4 |
| `serverCertificateHashes` | 100 | 125 | 26.4 |
| `datagrams` | 97 | 114 | 26.4 |
| `sendOrder` / `createSendGroup` | **no** | preview | 26.4 |

Chrome also hardcodes `maxDatagramSize` to 1024 with a standing TODO, so the measured
1211 is the Node client's answer, not Chrome's.

### F10. Safari cannot talk to a quiche-backed server
Verified against the shipped binary, not relayed. Upstream issue #490 ("Safari client
won't send without WT_MAX_DATA flow-control credit", open since 2026-07-10). Safari 26.4
implements draft-15 session-level flow control and will not send until credited.

Searching the shipped `webtransport.node` binary: `WT_MAX_DATA`, `WT_DATA_BLOCKED` and
`WT_STREAMS_BLOCKED` occur **zero** times, while implemented capsules
(`CLOSE_WEBTRANSPORT_SESSION`, `DRAIN_WEBTRANSPORT_SESSION`, `ADDRESS_ASSIGN`,
`DATAGRAM`) occur 2-23 times each — so the absence is real, not a search artefact. The
binary advertises only `SETTINGS_WEBTRANS_DRAFT00` and
`SETTINGS_WEBTRANS_MAX_SESSIONS_DRAFT07`; the settings Safari needs
(`WT_INITIAL_MAX_DATA`, `WT_INITIAL_MAX_STREAMS_UNI/BIDI`) are absent. Current
google/quiche `capsule.h` still has `WT_MAX_DATA` commented out and the blocked capsules
under `TODO(b/264263113)`.

The maintainer's position (2026-07-12): *"it is not implemented in quiche, so until they
do, no safari"* — and he will not patch quiche. The only workaround he offers is the
reliable fallback D3 forbids. The fix is proven feasible (quic-go/webtransport-go#261,
+29/-6, merged 2026-06-14) but must land in quiche.

**Consequence: Safari is de facto unsupported in v1.** See D11.

### F11. Upstream defects that become our tests
- **#365** — writing a zero-length `Uint8Array` freezes the server with a `quic_bug`.
  Forbid zero-length frames and datagrams outright (D12).
- **#425** — RSS 500M→700M+ over 12h at 2,500 sessions / 500 concurrent, attributed to
  stream churn. D2 opens a stream per call, maximally exercising it. Promoted to a
  Stage 1 graduation criterion (D13).
- **#5** — outgoing datagrams are never expired despite the spec requiring it, open since
  2022. Our queue owns expiry (D15).

### F12. Deployment requires raw UDP ingress
No edge or serverless runtime can terminate a WebTransport session. Among long-running
hosts the deciding factor is raw UDP ingress. Railway has none (no UDP docs exist; all
UDP paths 404, only TCP Proxy). Fly.io has it, requiring a dedicated IPv4, binding to
`fly-global-services`, matching internal/external ports, and it takes ~2 dozen bytes off
the MTU. AWS NLB shipped QUIC passthrough 2025-11-13 with QUIC-Connection-ID stickiness.

Scope rule: exactly one deployment fact is library-level, because it is a requirement
rather than a recommendation (D19). Everything else is non-normative example-app docs.

---

## Part 3 — Decisions taken during Phase 1a

### D10. No-fallback is enforced server-side; the client check is defence in depth
The obvious client guard does not work. `requireUnreliable` and `session.reliability` are
both unsupported in Chrome (F9), so asserting `reliability === 'supports-unreliable'`
would refuse **every Chrome session**.

- **Server (the actual guarantee):** construct only `Http3Server`. Never `Http2Server`,
  never `reliability: 'both'`. If our server never listens for H2 extended CONNECT, no
  client can negotiate a reliable-only session with us, whatever its browser supports.
  This is browser-independent and testable, and it is the assertion the e2e suite makes.
- **Client (defence in depth):** set `requireUnreliable: true` — honoured on
  Firefox/Safari, harmlessly ignored on Chrome — and assert
  `reliability !== 'reliable-only'` so Chrome's `undefined` passes.
- **Node client:** implements the property, so the strict check applies there.
- If the assertion fails, the session is refused, never degraded. The e2e suite fails
  loudly rather than silently running over TCP.

**Revisit when:** Chrome ships `reliability`, at which point the client check tightens to
strict equality.

### D11. Safari is unsupported in v1, and the failure is detected rather than silent
Given F10, README states Chrome and Firefox only, with the reason. The e2e matrix drops
Safari. Known issues gets a "detection lies" entry: Safari reports WebTransport support
and the session establishes, then no application bytes flow.

We do not merely document it — we detect it. See D16.

**Revisit when:** google/quiche implements the session-level flow control capsules and
`@fails-components` ships a release built against it. Concretely: `WT_MAX_DATA` appears
in the shipped binary's strings.

### D12. Zero-length frames and datagrams are a protocol error
Stream close is D7's terminator, so no zero-length sentinel was ever needed. A length
prefix of 0 is a protocol error; the receiver rejects the frame rather than forwarding
it. Same for zero-length datagrams. Explicit tests on both sides, because upstream #365
freezes the server rather than erroring.

### D13. Memory growth is a Stage 1 criterion, per lane, with a named exemption
**500 concurrent sessions, 60 minutes, on the pinned Node.** Sample RSS after a forced GC
every 5 minutes from T+10 to T+60 and fit a line: **the slope must stay under 4 MB/h**, and
absolute RSS must stay under 600 MB. The 10-minute warmup excludes startup allocation so
the measurement is slope, not noise. Run manually before Stage 1, never on PRs — too slow
and too flaky for a merge gate, and it would be disabled within a month.

The threshold was originally 5% growth between two point samples. That was wrong, and wrong
in a way worth recording: against the upstream leak's own 16.7 MB/h, the 50-minute window
yields ~13.9 MB, which at any plausible baseline is 2.8–4.6% — **under the threshold**. The
criterion would have certified the exact leak it was written to catch. A threshold stated
as a proportion of a baseline we do not fix in advance is unfalsifiable, and two point
samples are not a slope.

**The criterion is per lane, because the lanes differ and only one of them fails.**

| lane | requirement | status |
|---|---|---|
| emit (stream) | slope under 4 MB/h | must pass — measured flat |
| datagram | slope under 4 MB/h | must pass — measured flat, 20,000 sends plateau at 112 MB |
| `call()` | **exempted**, see below | fails: 5.95 KB per stream, server-side |

**And it is per axis, because the lane split was not the only blind spot.** `soak.node.ts`
opens its 500 sessions once and closes none, so it measures what a *live* session costs and
is structurally incapable of seeing what a *dead* one leaves behind. Three per-disconnect
defects were found by inspection while that soak was green (D76). `soak:churn` is the
second axis: connect/disconnect over loopback, bounded at **2048 bytes retained per session
churned** by linear fit. See D76 for why its warmup is measured in seconds.

**The `call()` exemption, with its cause and its expiry.** D67 ships with a known leak, and
that cannot coexist with a criterion that forbids one, so the criterion says which leak and
why rather than being quietly ignored at publish time.

- **Cause:** an unbounded per-bidirectional-stream leak in the reference transport, not in
  this library. Our own path over an in-memory transport costs 0.045 KB per call; the
  binding leaks the same amount with none of our code present (D65). Reported upstream.
- **Number, pinned:** **5.95 KB per stream server-side**, 5.88 KB client-side, held by
  `packages/core/src/bench/stream-churn.node.ts`, which asserts against a recorded
  observation of 11.6 KB for both halves in one process.
- **Mechanical expiry:** the exemption lifts the moment
  `npm run bench:stream-churn` reports **below 1 KB per stream**. At that point the
  `call()` lane rejoins the criterion with no further judgement required, and the bench
  prints a notice when it drops far enough to warrant re-running the soak.

An exemption with a named cause, a pinned number and a mechanical trigger is a decision.
Deleting the criterion would not be.

### D14. Runtime split: Node for the transport, Bun for everything else
Settled by F7, not by preference.

- **Node** runs anything that loads the quiche transport: session host, integration
  tests, e2e server process, example app.
- **Bun** runs everything that does not: typecheck, Biome, knip, build, pure unit tests
  including the framer property tests.

Enforced two ways so it is mechanical rather than remembered:
1. Filename split — `*.node.test.ts` for anything loading the transport, separate
   scripts, CI runs both. A test importing quiche must never be reachable from the Bun
   test task.

   A convention only means something if the runner honours it, and Bun's default glob is
   wider than it looks. It matched `*.node.test.ts` — `bun test` picked up 9 files where
   it should have seen 8, loading the native addon in the runtime that segfaults on it —
   and it later matched the Playwright `*.spec.ts` suite too, which failed with
   `Playwright Test did not expect test() to be called here`.

   The unit script therefore excludes both explicitly, and the exclusion is checked by
   comparing file counts rather than assumed: 14 files unfiltered, 11 filtered. Both
   escapes were the same mistake — assuming a runner's default matches the intent of a
   filename — and a third would be a reason to stop relying on globs entirely.
2. **An import-boundary lint rule** forbidding `@fails-components/*` imports from any
   file not matching `*.node.*`. This fails at typecheck instead of as a segfault that
   looks like flaky CI.

Recorded in `ADR/runtime-split` with the segfault evidence so nobody simplifies it back
to one runtime.

### D15. Backpressure: one policy, three lanes, numbers not adjectives
The three constraints resolve differently because the lanes make different promises.

- **Datagram lane, per peer:** bounded ring of **64 frames**, drop **oldest** on
  overflow. Oldest-first because every real datagram payload is last-write-wins, so
  stale frames are the ones worth losing. 64 frames is ~1s of buffer at 60Hz. Drops
  increment a counter and never throw: dropping is the lane's advertised contract.
- **Stream lane, room broadcast, per peer:** bounded queue of **256 frames**, then close
  the session with `WT_PEER_TOO_SLOW`. No dropping — a reliable lane that silently drops
  is exactly the lie the thesis forbids, and a peer 256 frames behind is already gone.
- **Token/call streams:** no queue, no drop. Propagate backpressure to the handler by
  awaiting `writer.ready`, high-water mark **16 frames**. This falls out of D2 for free:
  each call owns its own QUIC stream, so a stalled consumer applies flow control to its
  own producing handler and cannot touch another call. "One slow consumer must not stall
  the others" is satisfied by the transport, not by our queueing.
- **Stale datagrams (separate axis from overflow):** a TTL checked at **dequeue**, not
  enqueue. Drop-oldest handles a burst but does nothing for a peer that stalls two
  seconds and resumes — the ring never overflows and we deliver 64 stale cursor
  positions, which is worse than dropping them because the app renders history. Counted
  as `staleDropped`, separate from `overflowDropped`, so the two causes stay
  distinguishable. **Default TTL is 150ms**, overridable per event, with `ttl: null`
  disabling expiry for events that want raw delivery. 150ms sits inside the window where
  a late frame is still worth showing: cursor lag is perceptible around 100ms and reads
  as broken by 200ms. The interaction with the ring is what makes it work — a peer
  stalling 2s leaves 64 queued frames, and at 60Hz all but the newest ~9 are past TTL, so
  they are dropped at dequeue rather than rendered as history. The two counters matter
  more than the number: an app can tell a slow network from a slow consumer.
- **On the swallowed `blocked` signal (F4):** we do not attempt to infer network
  congestion, because we cannot. We bound our own queue and expose `droppedDatagrams`
  and `queueDepth` per peer, documented as *our* drops, not the network's. Claiming to
  detect QUIC-level congestion would be a fiction.

**Revisit when:** a 50-peer room at 60Hz shows >1% drop rate in the example app, or any
stream-lane disconnect is observed at a queue depth under 256.

### D16. Error normalization layer, isolated and pinned
Given F5, every transport error passes through one adapter function that maps it to a
stable `WT_*` code. String-parsing the message is acceptable *only* inside that single
function, with a test pinning the observed format and a comment recording the upstream
defect. Tested against the real transport, never a fake.

### D17. Schema layer: BYO via Standard Schema, no built-in validator
Core accepts anything implementing `StandardSchemaV1` — zod, valibot and arktype all ship
it — so core has zero runtime dependency and zero peer dependency. A types-only `type$<T>()`
helper serves users who want inference without runtime validation. Validate inbound only,
never outbound: you produced your own payload, and double validation doubles hot-path cost.

### D18. No default call timeout
Peer death is already handled: QUIC's idle timeout rejects `session.closed`, which rejects
every pending call with `WT_SESSION_CLOSED`. A default timeout would reintroduce the
pending-map bookkeeping D2 exists to delete. Ship `AbortSignal.timeout(ms)` as the
documented idiom, plus a server-side cap of 256 concurrent streams per session rejecting
further opens with `WT_TOO_MANY_STREAMS`, so a leaking handler cannot exhaust the session.

### D19. Datagram sequence numbers live in the protocol, scoped to the ORIGIN
A `uint32` monotonic sequence per **(origin, event)** on the datagram lane, where origin is
a `uint32` identifying the producing peer (first four bytes of SHA-256 of its `PeerId`),
carried in the datagram header.

The original scoping was `(session, event)` and it was broken under room fan-out, in two
separate ways. A broadcast encodes one frame and hands the same bytes to every recipient
(D5 forbids re-encoding per recipient), so a session-scoped sequence cannot be correct for
more than one of them. And had the counter belonged to the receiving session, every
originating peer would share it: a peer sending for a minute reaches sequence 3000, a peer
joining reaches 1, and the newcomer's datagrams are discarded permanently as stale. Keying
on origin makes one encoding correct for every recipient and keeps senders independent.

The origin field also supplies what D20's self-publish dedupe needed and previously had no
place to live. With the four-byte event ID (D52) the header is 13 bytes and the conservative
payload maximum is 1011.

**Origins are quarantined and reused, not retired.** The first draft said never reuse
within a host's lifetime, which is right about correctness and wrong about operations: 2²²
values at 100 sessions per second exhausts in 11.7 hours, so a busy host would stop
accepting sessions and need a restart — a scheduled outage disguised as a safety property,
arriving in production because it is a function of uptime times load rather than of
anything testable.

Reuse is provably safe because both confusable windows are values this protocol sets: a
receiver discards `(origin, event)` sequence state after 60 seconds idle, and an in-flight
datagram cannot outlive the 150 ms send-queue TTL plus transit. A released origin is
therefore quarantined **120 seconds**, twice the longer bound. Steady-state occupancy
becomes `concurrent + churn × 120s` — 1.4% of the space at 500 sessions/second — so
exhaustion is a genuine limit on **concurrency**, roughly 4.2 million live-plus-quarantined
per host, never a clock.

Host ordinals recycle under the same rule with a **300-second** quarantine, because
autoscaling churns hosts and a 1,024-value space would otherwise exhaust for the same
reason. **1,024 concurrent session hosts is a stated ceiling**, not an implementation
detail; a deployment approaching it needs a wider origin field behind a `feat` token.

All four intervals are constants in `protocol.ts` and are asserted against PROTOCOL.md by
the docs gate. Core drops stale
and duplicate arrivals by default and exposes `{ seq, staleDropped }`. Every datagram use
case wants last-write-wins; making each app rebuild it is the too-raw-primitive mistake.
Opt out per event for apps that want raw.

**Constraint:** the complete datagram header layout goes in PROTOCOL.md as one table with
a total byte count **before** these 4 bytes are added, and the max payload constant is
derived as `floor - header`, never hardcoded. The floor is Chrome's 1024, not the measured
1211. A test asserts a maximum-size payload round-trips at the 1024 floor. Adding header
fields one question at a time is how a datagram protocol quietly outgrows its own MTU.

Fly.io's "we swipe a couple dozen bytes from your MTU" is cited in the PROTOCOL.md
rationale as direct evidence for runtime discovery over a hardcoded constant.

### D20. Self-publish: core dedupes, local delivery does not round-trip the bus
Every frame is tagged with an originating `nodeId` (per-process ULID); self-originated
frames are filtered on receive. Local peers are delivered immediately rather than waiting
for the bus to echo — lower latency, no dependency on adapter round-trip. Documented
consequence: local peers observe a message before remote peers. That is inherent to any
fan-out and is stated rather than hidden.

### D21. Transport seam: build it now, use it once
One internal `Transport` interface with a single implementation (`FailsTransport`). Not a
public plugin API, not exported in v1. Same argument as `HostileAdapter`: a boundary with
one implementor is usually wrong, and two credible second implementors now exist
(`@moq/web-transport` 0.1.4, NAPI-RS over Rust quinn; Deno 2.2+ `Deno.QuicEndpoint`). The
cost is one file; the benefit is that the quiche defects in F3-F5 and F10 stay quarantined
behind an interface instead of leaking into session logic.

**Recorded constraint:** Chrome implements neither `sendOrder` nor `createSendGroup`
(F9), so stream prioritisation must not be designed into the protocol on the assumption
that primitive exists. This lives in the transport-seam ADR so nobody later builds on it.

### D22. `Publisher` is internal in v1
D9's Publisher is a design constraint, not a public API. A per-invocation serverless
Publisher needs a shared bus, but v1 ships only `MemoryAdapter` (in-process) and excludes
Redis — so nothing in v1 can publish across processes. Define the interface, test it
against `HostileAdapter`, keep it internal, and export it when the Redis adapter makes it
real. Same treatment and justification as `Transport` (D21).

### D23. Deployment is not our problem; exactly one fact is library-level
We ship a library. Where someone runs it is their concern, and a vendor matrix is stale
the moment Railway ships UDP. README requirements carries exactly this, next to the Node
version — no vendor names, no flags, no comparison table:

> transport-io requires raw UDP ingress to your process on the port you listen on. Unlike
> TCP, many managed platforms do not provide this. Verify your platform routes UDP before
> building on this.

Everything else — Fly's dedicated-IPv4 and `fly-global-services` details, the AWS NLB
QUIC passthrough path, platforms that currently cannot do it — moves to the example app's
own docs, dated and marked non-normative.

Two items from that research are design record, not deployment notes: Fly's MTU
observation (cited in D19) and NLB's QUIC-Connection-ID stickiness, which is the answer
to connection migration behind a load balancer and belongs in known issues as a technical
note, since a naive 4-tuple-hashing balancer will break sessions when a client changes
network.

---

## Part 4 — Code hygiene decisions

### D24. Hygiene precedes source
The first commit of Phase 2 is tooling and nothing else. CI passes before a single
library file exists. Retrofitting standards onto code written without them is how a
codebase rots, and this one is too young to carry any debt.

**Knip on an empty repo:** the first commit ships a single stub entry per package —
`packages/core/src/index.ts` exporting only the package version constant. That satisfies
knip's entry resolution and keeps the spirit of the rule: every gate exists and passes
before real code lands. A version export is not library code.

### D25. Toolchain
- TypeScript strict, plus `noUnusedLocals`, `noUnusedParameters`,
  `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`.
- `tsc --noEmit` in CI. Neither Bun nor Biome typechecks.
- ESM only. No CJS build.
- CI runs on a glibc image, and per F2 not a default `-slim` tag.
- Transport version pinned exactly, prebuild download cached in CI, GitHub dependency
  noted in README requirements.

### D26. Dead code is a CI failure, not a warning
Highest-priority lint. `knip` for unused files, exports and dependencies; non-zero exit
fails the build; no allowlist entry without a comment saying why. Biome for format and
lint in one pass, replacing Prettier and ESLint. No `biome-ignore` without a reason string.

### D27. Tests that cannot pass vacuously
The failure mode designed against is a test asserting that the implementation does what
the implementation does.

- Property-based tests on the framer with `fast-check`. Required. Random message
  sequences, random chunk boundaries, round-trip equality.
- **F6 is a required fixture**: many small writes plus one large write, asserting the
  framer recovers exact message boundaries.
- Explicit byte assertions for protocol frames. No snapshot tests — a snapshot records
  whatever the code did, including the bug.
- Tests assert against PROTOCOL.md and API.md, never internal structure.
- Never mock the thing under test. Adapter tests run against `HostileAdapter`.
- Type-level tests proving a wrong event name or wrong payload fails to compile.
- No coverage threshold. Coverage targets manufacture exactly the self-satisfying tests
  being avoided. Review test quality instead.

### D28. E2E from Phase 2a, not Phase 3
Real browser, real server process, real certificate. Playwright driving Chrome against a
spawned Node server using the self-signed certificate hash flow. The minimal harness
arrives in **Phase 2a** — two pages, one server, the two-context room test as soon as
there is a room to test. The Phase 3 example app becomes the fixture by **replacing** the
harness, not by introducing e2e for the first time. Runs on every PR. A flaky e2e test
gets fixed or deleted, never wrapped in a retry loop.

Canonical test: two browser contexts join one room, one message on each lane, both
contexts receive.

### D29. Commit conventions enforced at both gates
We squash merge, which changes where enforcement matters.

- **PR title is the squashed commit subject**, so the PR title lint gate is load-bearing.
  It is the thing that protects the changelog.
- **PR body becomes the commit body.** `BREAKING CHANGE:` footers are authored there —
  document this, it is the part people get wrong.
- The pre-commit hook stays, but its real job is fast local feedback and keeping the
  branch readable during review. Individual commits are squashed away, so the hook is a
  nicety and the PR title gate is the guarantee. The hook does not make the PR gate
  redundant.
- Same commitlint config for both so they cannot drift.
- Repository settings: squash merge only, linear history required, both gates required.

**Scopes are required, not optional:** `feat(core):`, `fix(react):`, `chore(ci):`.
transport-io gets its own commitlint config; the global `^[A-Za-z0-9 ,:]{4,72}$` subject
rule from hela does not travel here. Parentheses are allowed, and the scope is validated
against the actual workspace package list so `feat(cor):` fails.

**Subject only, never a body.** No commit has a body — not for rationale, not for
context, not for issue links. A subject line is the whole commit message.

- commitlint enforces an empty body.
- Breaking changes use the `!` marker, because a `BREAKING CHANGE:` footer would require
  a body: `feat(core)!: rename emit to send`.
- The repository's squash merge message is set to **"Pull request title only"**. GitHub
  defaults to including the PR description as the body, which would break this rule on
  the only commit that survives.
- Rationale lives in the changeset, the ADR, or PROTOCOL.md. Those are read; commit
  bodies are not.

**Frequent, small, individually green.**

- One logical change per commit. If the subject needs "and", it is two commits.
- Never mix a refactor with a behaviour change.
- Every commit passes typecheck, lint and unit tests on its own. Bisect is the payoff for
  small commits, and it only works if each one is green.
- Commit at every green state rather than at the end of a task. A day of work is many
  commits, not one.
- Tests land in the same commit as the code they cover.
- No line-count threshold. The "and" test and the green test are the standards.

### D30. Changesets, and canary from day one
Changesets over release-please, because independent per-package versions are a hard
requirement: core reaches 1.0 while the Redis adapter stays at 0.x. CI fails any PR that
changes a package without a changeset. **Empty changesets for tooling and CI PRs are the
accepted cost**, with a documented one-liner for generating one so it is a reflex rather
than a chore.

Canary from day one: `changeset version --snapshot` publishing under the `canary`
dist-tag on merge to main. Nothing reaches `latest` until Stage 1 — so **Stage 1 begins
at the first stable publish, not the first publish of any kind.**

### D31. CI on every PR
One workflow, all required to merge, fast checks first: typecheck, Biome, knip, Bun unit
tests, Node integration tests, Playwright e2e, changeset presence.

---

## Part 5 — Decisions from Phase 1a batch two

### D32. Stream-lane `emit` uses one long-lived unidirectional stream per direction
Not one stream per emit. Emits are fire-and-forget, and ordered-within-lane is the
guarantee chat actually wants. One stream per emit would multiply the #425 stream-churn
leak by message volume and add stream-ID accounting per message. `call` gets its own
stream precisely because isolation is the point *there*.

Emit payloads are capped at **1 MiB**; anything larger belongs in a `call`.

**Accepted cost, stated plainly because it is easy to miss: the head-of-line blocking is
cross-room.** All rooms share one emit stream per direction, so a busy room delays a quiet
room's messages to the same peer. That is the problem this transport is sold as solving,
reintroduced on the lane most apps will use most. The trade is still right — per-room
streams would multiply #425 churn by room count, and `call` plus datagrams stay isolated —
but it is a cost, not a free lunch.

This must appear in **three** places, not one: PROTOCOL.md's emit lane section, the ADR
as an accepted cost with the revisit trigger below, and the README so nobody reads
"independent streams" as a promise about emits.

**Revisit when:** p99 emit delivery latency to a peer in a quiet room exceeds 100ms while
a room that peer also belongs to is sustaining more than 200 emits/second.

**Per-room emit lanes are a future `feat` token, not a permanent no.** Reserved as
`emit-per-room`. Reserving costs nothing and matches the D7 pattern of keeping protocol
space open; deciding it now means a chatty room is a negotiation, not a redesign.

### D33. The handshake is frame 0 of the emit stream
Not a dedicated stream. In-order delivery within a stream makes early traffic impossible
by construction: nothing can arrive before the handshake because everything is behind it
in the same stream. This removes a race rather than guarding it, and it deletes the
`WT_HANDSHAKE_NOT_COMPLETE` session-close rule entirely.

Each side writes `{ v, feat }` as frame 0 of its own outbound emit stream, so the shape is
symmetric.

Two residual cases remain, and both resolve into existing behaviour rather than new rules:

- **Datagrams** are not on the emit stream, so one can still arrive first. It is dropped
  silently — exactly the unreliable lane's advertised contract. No error, no new rule.
- **`call` bidi streams** can still race. The server answers on that stream with a
  call-error frame and resets it. No session close; it reuses the error path that already
  exists.

**Deadline: 5000ms in both directions**, producing `WT_HANDSHAKE_TIMEOUT`. A peer that
never opens its emit stream is indistinguishable from one that never handshakes, so the
same deadline covers both — and this is what converts Safari's silent hang (F10, D11)
into a named error whose message states the likely cause.

The cost accepted: a version mismatch is refused after a stream reader is allocated
rather than before. That is one reader, against removing a race from the protocol.

### D34. Version negotiation semantics
The handshake frame carries `{ v: <integer>, feat: <string[]> }`.

- `v` is the protocol major. **Stage 0: both sides require exact equality and refuse
  otherwise** — the mechanism exists, the compatibility promise does not.
- From Stage 1, a major mismatch refuses the session with `WT_PROTOCOL_VERSION_MISMATCH`;
  the minor surface is the **intersection** of the two `feat` lists, so old clients keep
  working and new ones light up extras.
- `feat` tokens are short lowercase ASCII. Reserved so far: `emit-per-room` (D32),
  `codec-msgpack` (D36), and a future session-resume token (D4).

### D35. Rooms are server-authoritative
A client cannot join by sending a frame. The server calls `session.join(room)` in
application code. `join` / `leave` exist on the wire only as **server→client
notifications**, so the client's observable snapshot can reflect membership.

Client-initiated join is an authorization hole, and the kickoff fixes auth as one hook
rather than a pipeline — if clients could self-join, every app would need to validate room
names on a join path, which is middleware wearing a different hat. An app that genuinely
wants client-initiated subscribe routes it through a `call` handler, which is already the
authenticated path. This also matches the reference: Socket.IO rooms are
server-authoritative.

### D36. Error codes: numeric on the wire, `WT_*` in the API, one table
PROTOCOL.md carries a single table mapping numeric code ↔ `WT_*` name ↔ meaning ↔ what to
do about it. A Go implementer needs the number; our users need the name.

- **Stream reset codes are one byte, 0–255.** Chrome types `streamErrorCode` as
  `[Clamp] octet` and the library clamps identically, so this is a protocol-wide
  constraint rather than a library quirk, and the abort-code budget must fit in it.
- **Session close codes get the full 4 bytes** (`closeCode` is `unsigned long`), with the
  reason string capped at **1024 bytes** per the HTTP/3 draft.

### D37. Codec seam: one byte, `0x01` = JSON/UTF-8, `0x00` reserved invalid
One codec byte in the stream frame header and in the datagram header. Reserving `0x00` as
always-invalid means a zero-filled buffer can never parse as a valid frame — free
corruption detection. v0.1 receivers reject anything other than `0x01` with
`WT_UNSUPPORTED_CODEC`. Future codecs negotiate through the `codec-msgpack` `feat` token,
so msgpack fits later without a protocol break.

### D38. Snapshot API: `subscribe` / `getSnapshot`, referentially stable
`client.subscribe(cb) => unsubscribe` and `client.getSnapshot() => ClientState`, where
`ClientState` is a frozen `{ status, sessionId, rooms, lastError }` and `status` is
`'idle' | 'connecting' | 'connected' | 'closing' | 'closed'`.

**`getSnapshot()` must return the same reference when nothing has changed.** Returning a
fresh object each call makes `useSyncExternalStore` loop forever. This is the single most
common way this shape is gotten wrong, so it gets an explicit test rather than a doc note.

---

## Part 6 — Sweep decisions (requirements found unmapped, now resolved)

A mechanical pass over the kickoff prompt, the hygiene addendum and both review replies,
listing every requirement, constraint or finding with no numbered decision. Each is
resolved here rather than left as an implementation assumption.

### D39. Project lifecycle and graduation criteria
**Stage 0 (now, unpublished):** breaking changes are free and expected. No backward
compatibility of any kind, no deprecation paths, no compatibility shims, no migration
guides, no version checks against an older release — there is no older release. Rename
freely, including package names, exports and file layout. The protocol is v0 and unstable.

**Stage 1 begins at the first *stable* publish, not the first publish of any kind** (D30
puts canary on `latest`-free `canary` from day one). At Stage 1 everything inverts: semver
applies, the protocol version becomes a promise, and breaking changes need a major bump
plus a migration note.

**Graduation criteria — all six, so this is a decision and not a vibe:**
1. PROTOCOL.md unchanged for a full working example.
2. Both lanes exercised end to end in the example app.
3. Adapter conformance suite passing against `HostileAdapter`.
4. Backpressure policy implemented, not just specified.
5. Someone other than the author has run it.
6. The memory soak in D13 passes.

**CHANGELOG.md exists from day one.** During Stage 0 it records what changed for the
author, not migration instructions for users who do not exist.

### D40. Adapter interface, `HostileAdapter`, and the rules that fall out
```ts
interface Adapter {
  join(room: string, peer: PeerId): Promise<void>
  leave(room: string, peer: PeerId): Promise<void>
  broadcast(room: string, frame: Frame, opts: { lane: Lane }): Promise<void>
  onRemote(cb: (room: string, frame: Frame) => void): void
}
```

`MemoryAdapter` ships in core and is the default, so `npm install` works with zero config
and zero infrastructure.

**`HostileAdapter` is a test-only second implementor**, because an interface with one
implementor is usually wrong and `MemoryAdapter` is a misleading sole implementor: it is
effectively synchronous, never fails, passes live object references and always knows full
room membership. None of that holds for a real bus. It must serialise every frame to bytes
and back, add artificial async latency, deliver the publisher its own messages, reorder
deliveries, and fail on command. The conformance suite runs against both.

**Rules core obeys from day one:**
- Every adapter method is async, even in memory.
- `PeerId` is a stable, cross-process-meaningful string. Never an object reference.
- Frames cross the boundary as bytes. Never live objects.
- Core must not assume the local node knows a room's full membership.
- A frame arriving for a room with no local members is **dropped silently, not an error**.
- A node receiving its own publish back is normal; dedupe policy is D20.
- **Any adapter method may reject, and core must degrade rather than crash.** A rejected
  `broadcast` is reported through the error channel and does not tear down the session.

### D41. Framework binding surface
Core must make `@transport-io/react` a thin wrapper rather than a rewrite. All of these
hold from the start, and API.md gets a **"Framework binding surface"** section listing
exactly which core APIs a binding consumes, so a change that breaks the plan is visible.

- **Zero framework imports in core, forever.** No React, no Next, not even type-only.
- `subscribe` + `getSnapshot` observable snapshot alongside the event API (D38).
- **`on()` returns an unsubscribe function.** Not `off(name, fn)`. This makes `useEffect`
  cleanup a one-liner and avoids identity problems with inline handlers.
- **Constructible without connecting.** `new Client(...)` does no I/O; connection is an
  explicit call.
- **Import-time SSR safety.** Nothing touches `window` or `WebTransport` at module scope,
  because Next.js will import this on the server where `WebTransport` does not exist.
  Feature detection happens at connect time and throws `WT_NO_SUPPORT`.
- **No module-level singletons or global mutable state.** It breaks request isolation on
  the server and makes tests order-dependent.
- **Idempotent connect/disconnect with refcounting.** React StrictMode mounts twice in
  development; two components sharing one client must not tear each other's connection
  down.

### D42. Agent friendliness
- **`AGENTS.md` at the repo root**: the whole API in a form an agent reads in one pass.
  What the exports are, what the contract looks like, what the errors mean. Not marketing.
- **The contract file is the single source of truth.** An agent reading `contract.ts`
  knows every event, payload and lane in the app without reading anything else. This
  property is protected, not incidental.
- **Type complexity budget.** Deeply conditional inferred types produce hover output and
  error messages neither humans nor agents can parse. If `emit` hover shows forty lines of
  conditional type, the design failed. Prefer a simpler inference strategy over a cleverer
  one, and test that a wrong payload produces a readable error rather than type soup.
- **Every error carries a stable code and a sentence saying what to do about it.** Never a
  bare `TypeError`. Named in the kickoff and reserved now: `WT_NO_SUPPORT`,
  `WT_ROOM_NOT_JOINED`, `WT_DATAGRAM_TOO_LARGE`.
- **Every snippet in the docs runs as written.** No pseudo-code.

### D43. Core dependencies and monorepo layout
Core has **zero runtime dependencies beyond the WebTransport binding**. D17 (Standard
Schema, no bundled validator) is one instance of this rule, not the whole of it.

**Layout in v1 is `packages/core` and `examples/chat`. `packages/redis-adapter` is not
created.** The kickoff's Phase 2 sketch lists it, but D5 and D22 exclude Redis from v1 and
forbid core from referencing it — and an empty package would trip knip, add a changeset
surface, and imply a v1 promise we are explicitly not making. It arrives after v1, on its
own schedule, at its own version. This is a deliberate deviation from the kickoff's
directory sketch, recorded here so it is not read as an oversight.

### D44. Serverless publish path constraints
Even though the cross-process `Publisher` is internal in v1 (D22), these constrain core
now, because retrofitting them is expensive:

- The publish path has no cold-start session setup and no background subscriber.
- Nothing assumes the publishing process is also a session host.
- **Nothing in core assumes a single shared process.** Room membership lives in the
  adapter, never in a module-level map in core.

### D45. Spec-first during implementation
Implementation follows PROTOCOL.md. If implementation reveals the spec is wrong, **update
the spec first and say so, then continue.** Code never silently diverges from the document
another language is meant to implement from.

### D46. Framing edge-case test matrix
Beyond the F6 property tests, these four cases are named explicitly and each gets a test:
1. A read delivering **half a frame**.
2. A read delivering **three frames** at once.
3. A frame **split across three reads**.
4. An **oversized datagram**, asserting `WT_DATAGRAM_TOO_LARGE` from our layer (F4 means
   the transport will not tell us).

### D47. README structure
Limitations go **above** the install instructions, in a confident tone, not buried in a
FAQ. Four topics, stated as facts rather than apologies: no fallback and why; reconnect
semantics; datagram guarantees; protocol versioning policy.

Also required in README by earlier decisions: the glibc/default-slim-tag warning (F2), the
GitHub-Releases prebuild dependency (F1), the raw-UDP-ingress requirement (D23), the
Chrome-and-Firefox-only support statement (D11), and the cross-room emit blocking (D32).

### D48. PROTOCOL.md is implementable from the document alone
The target reader is someone writing a Go server with no access to our source. Socket.IO's
real sin was an undocumented custom protocol only their own client could speak.

It must **explicitly state what is not guaranteed on the datagram lane** — not imply it,
not leave it to inference.

### D49. No open-questions file, and the Phase 1 gate
This project has no `OPEN-QUESTIONS.md` and never will. An open-questions file is where a
design flaw goes to be forgotten: it reads as diligence and functions as a deferral.

Resolved does not mean certain. Where something cannot be known before implementation, the
resolution is a decided default plus the specific observable trigger that would make us
revisit it, recorded as an ADR.

**Gate for entering Phase 2:** no document may contain `TBD`, `FIXME`, "we will decide
later", "for now maybe", "probably", "should be fine", or an unanswered question mark.
Grep for these before declaring Phase 1 complete.

### D50. ADR index
One short record each for decisions a future contributor will want to reverse. Each states
the decision, the alternative rejected, and what would justify revisiting it.

Minimum set from the kickoff: `lane-in-contract`, `streams-as-acks`, `no-fallback`,
`new-session-on-reconnect`, `adapter-boundary`. Added by Phase 0 and Phase 1a:
`runtime-split` (D14, with the segfault evidence), `transport-seam` (D21, carrying the
Chrome `sendOrder` constraint), `backpressure` (D15, carrying the TTL and both counters),
and `emit-stream-multiplexing` (D32, carrying the cross-room cost and revisit trigger).

### D51. Working style
- Ask when a decision is unresolved; never guess and move on. An unasked question becomes
  a silent assumption in code.
- Every question carries a recommended answer and the reasoning. A question with no
  position attached is the same deferral the no-open-questions rule exists to prevent.
- If a fixed decision looks wrong, say so once with reasoning, then follow it unless it
  changes.
- Re-read CLAUDE.md at the start of every session. Before writing a deprecation path, a
  compatibility shim or a migration guide, check the stage first.
- **Append to DECISIONS.md as each batch is approved, not at the end.** The ledger is the
  artefact that survives a session ending; the conversation is not.
- Priority is shipping something real and honest, not something complete. Rough edges are
  acceptable if they are documented.

---

## Part 7 — Audit resolutions and final pre-implementation decisions

The pre-implementation audit raised 54 findings; 49 were upheld. Full detail in
`AUDIT.md`. The decisions below resolve them.

### D52. Event identity is a name hash, not a position
An event's wire identifier is the **first two bytes of SHA-256 of its name**, big-endian,
as a `u16`. Collisions are a contract-construction error naming both events, resolved by an
explicit `id` that becomes part of the contract.

Positional identity was the original draft and was never recorded as a decision, which is
how it survived unexamined. It fails on contract change: insertion renumbers every later
event, so during a rolling deploy the two halves of a fleet decode each other's traffic
incorrectly rather than failing cleanly. A name hash is a pure function of the name, so two
peers always agree for any name they share, and adding or removing events changes no
existing identifier.

Collision probability is ~0.3% at 20 events, 1.9% at 50, 7.3% at 100 and 26% at 200 —
acceptable only because it is detected at build time with a message naming both events and
the one-line fix. Full reasoning and the deploy story in `ADR/0010-event-identity.md`.

### D53. Contract identity is an event table, compared per event
The handshake carries `[name, id, lane]` per event. Comparison is per event, not
whole-contract: a lane conflict, an id conflict or a name/id crossover refuses the session
with `WT_CONTRACT_MISMATCH` naming the offending event; a name known to only one peer
proceeds and yields a per-message `WT_UNKNOWN_EVENT`.

**Payload schema shape is excluded entirely.** Adding an optional field is backwards
compatible by every normal definition, and a whole-contract hash would refuse every
existing session over it. The principle: the handshake refuses failures that cannot be
caught later, and permits those that can. Schema drift produces one readable
`WT_VALIDATION_FAILED` on one message; identity drift corrupts every message of that type
silently.

Ordering is specified because both checks live in the handshake: **the event table is
validated first and conflicts are fatal; `feat` is negotiated second and is never fatal.**
Full reasoning in `ADR/0011-contract-identity.md`. D34's exhaustive two-field claim is
corrected to three.

### D54. TypeScript 7, with a rollback trigger
Pin TypeScript 7.x. Verified: `tsc` builds under `isolatedDeclarations` +
`verbatimModuleSyntax` + `nodenext`; `knip` exits 1 on unused dependencies; `attw --pack .
--profile esm-only` and `publint --pack npm` both exit 0.

TS 7 removed the classic compiler API — `require('typescript')` returns only
`{ version, versionMajorMinor }`, and the programmatic API moved to `typescript/unstable/*`
pending a new API in 7.1. Editor support is **not** affected: TS 7 speaks LSP natively via
`tsc --lsp --stdio`, and the absence of `tsserver.js` is by design.

The constraint that follows, as a checked list rather than a note:
- **No tool in this repository may depend on the TypeScript compiler API** until 7.1 ships
  one. Audited: `knip`, `@arethetypeswrong/cli` and `publint` declare no `typescript`
  dependency and all three run correctly against TS 7.
- **`expect-type`, never `tsd`**, for type-level tests. `tsd` consumes the compiler API;
  `expect-type` is pure type-level. Pinned here so it is not swapped later for the more
  familiar name.
- The doc-compilation harness and the instantiation count invoke `tsc` as a **CLI**, never
  the API.
- Any future tool proposal states its compiler-API status before adoption.

**Rollback trigger:** if two or more mandated gates become unworkable before Phase 2b
completes, fall back to the 6.x line and revisit at 7.1.

### D55. Consumer TypeScript floor is 5.0, measured
Measured, not assumed: TS 4.9.5 fails on the emitted `.d.ts` with `TS1139: Type parameter
declaration expected` at the `const C` parameter; 5.0.4 through 5.9.3 pass. An isolated
probe confirms `const` type parameters are the single gate.

Stated in the README, and tested mechanically: CI typechecks the emitted `.d.ts` against
`typescript@5.0.4`.

### D56. Module resolution and extensions
`allowImportingTsExtensions` + `rewriteRelativeImportExtensions` under `module` and
`moduleResolution` of `nodenext`. Source writes `./util.ts`; emitted JS writes `./util.js`.

`moduleResolution: "bundler"` was the original instruction and is wrong for a library: it
permits extensionless imports that compile and then fail to resolve for a consumer under
`node16`/`nodenext` — creating precisely the hazard ATTW was mandated to catch.

`isolatedDeclarations` applies to **`packages/core` only**. It is incompatible with the
contract pattern by design: `export const contract = defineContract({...})` is exactly the
inference it forbids, producing 15 errors on a 9-line contract. `examples/chat` emits no
declarations and does not need it. This is scoping, not relaxation.

### D57. The interface form is canonical, not optional
Users write two lines, not one:

```ts
export const contract = defineContract({ /* ... */ })
export interface AppMap extends MapOf<typeof contract> {}
```

The second line is what makes hover readable, and it is **opt-in by nature**, so it must be
canonical by convention. Measured: with the interface, `emit` hover is 126 characters and
mentions no schema library. Without it — inline `MapOf<...>` or a library-supplied
`ClientOf<>` alias — it is 303 characters with the validator's internal types in it.
TypeScript preserves interface names but expands alias instantiations, so no library-side
trick removes the need for the line.

The interface form therefore appears in the README quickstart, in **every** API.md example,
in `examples/chat`, and in `AGENTS.md` when it lands. The inline form appears nowhere. One
sentence in API.md explains why the line exists, because an unexplained magic line is its
own developer-experience problem. The 126-character form is pinned in the type-level test.

### D58. Never reproduce an external interface from memory
Depend on the published source, or read it. Never retype an external type declaration,
constant, hash, or protocol value from recollection.

This is a rule because it nearly shipped twice. A hand-vendored `StandardSchemaV1` silently
broke every validator with a nine-line variance error, because the real spec had gained a
`StandardTypedV1` base and an options argument. A fabricated contract fingerprint appeared
in a document that promises every snippet runs. In both cases the invented value looked
plausible and was wrong.

Concretely: `@standard-schema/spec` is a dependency (types-only, zero runtime bytes), never
a copy. Any constant that can be computed is computed and checked in, never typed from
memory.

### D59. Audit resolutions
Applied to the documents: the frame length cap corrected to `1048580` (`Length` excludes
itself, as its own minimum of 5 already implied); the §7.1 diagram redrawn and verified at
8+16+32 bits = 7 bytes against the budget table; `JOIN` and `LEAVE` added to the `0x0000`
event-ID carve-out, since a room name is not a contract event; the 1 MiB cap scoped to
`EMIT` only, with calls at 16 MiB; `WT_TOO_MANY_STREAMS` moved from a session-close code to
stream reset code 9, matching D18's "reject the open" rather than killing the session;
`CALL_ERROR` restricted to §10.1 codes; exactly one response frame in v0 with receivers
accepting any number; and the eight fossils corrected, including
`WT_HANDSHAKE_NOT_COMPLETE` and the "three kinds of QUIC stream" count.

**Errors on the emit stream escalate to a session close.** There is one emit stream per
direction and no way to reopen it, so a stream reset would destroy all stream-lane traffic
for the session. Recorded in `ADR/0009` as a *consequence* of the shared-lane trade rather
than as an isolated fix: head-of-line blocking was accepted knowingly, this was not, and a
third consequence from the same source would be a reason to revisit the trade.

The six items previously listed here as "still open" were an open-questions list wearing a
different name, which this project bans. They are decided and applied:

- **`except()` crosses the bus.** `Adapter.broadcast` takes
  `opts: { lane: Lane; except?: readonly PeerId[] }`. Without it, exclusion silently applied
  only to local peers, so the canonical `except(session.id)` idiom would have echoed to the
  sender on every other node.
- **The two stale counters have distinct names.** `staleDropped` is the sender-side TTL drop
  (D15); `staleReceived` is the receiver-side sequence drop (D19). One name for two causes
  was the defect.
- **`returns` is only valid on the stream lane.** `EventDef` is a discriminated union on
  `lane`, so a datagram event carrying `returns` fails to compile rather than becoming
  callable over a lane with no response path.
- **Drop counters have a surface.** `Session.stats(): PeerStats` exposes `queueDepth`,
  `overflowDropped`, `staleDropped` and `staleReceived`. D15 mandated exposing them and
  nothing did.
- **The types-only helper is `type$<T>()`**, in the API and in D17. The two names disagreed.
- **`host` defaults to `'::'` and `path` to `'/'`**, stated in API.md §2.1. Both were
  invented while drafting and are now recorded as chosen: `'::'` because dual-stack is the
  right default for a server that expects browsers, `'/'` because a library that needs a
  path segment before it works has an avoidable first-run failure.

The stream frame header layout is likewise decided rather than pending: §5's diagram and
budget table are normative, verified at 12 bytes against the field list, and the `Reserved`
field introduced by the four-byte Event ID MUST be zero.

### D60. Threshold shape
Swept every numeric threshold in `DECISIONS.md` and the ADRs for the defect that broke D13.

Found and fixed: D13 itself. Found and tightened: the backpressure revisit trigger, whose
"1% drops" now names its denominator explicitly as
`(overflowDropped + staleDropped) / enqueued` over a 60-second window — both counters this
library owns. ADR 0002's trigger, previously the unfalsifiable "stream churn becomes the
dominant cost", now fires on the D13 slope or p99 call latency above 50 ms at 500
concurrent sessions.

Clean: the instantiation budget, the consumer TypeScript floor, the emit-lane latency
trigger, and every queue bound — all absolute. The 89.96% figure is a cited statistic, not
a threshold.

**Rule going forward: a threshold is stated as an absolute quantity, or as a proportion of
something this library counts. Never as a proportion of a baseline established at
measurement time.**

### D61. lefthook for git hooks, and what may not go in them
**lefthook**, not husky and not simple-git-hooks. Recorded with the reasons so nobody
swaps it later for a more familiar name:

- A single **Go binary**. Verified: the generated `.git/hooks/pre-commit` is a POSIX `sh`
  script that invokes a native executable directly. There is no Node in the hook runner
  path, unlike husky's shell-plus-Node arrangement.
- **Parallel execution** of hook commands, declared rather than hand-rolled.
- **One committed YAML file** at the repo root instead of shell scripts scattered across
  directories.

**Wiring.** `lefthook.yml` is committed at the root and installed by a `prepare` script, so
a fresh clone gets working hooks with no manual step. Verified by deleting both hooks and
running `npm run prepare`: 0 hooks before, 2 after.

**`pre-commit`** runs staged-file-scoped and parallel: Biome format and lint over
`{staged_files}`, and the documentation-staleness check.

**`commit-msg`** runs commitlint, enforcing subject-only, the scope validated against the
workspace package list, and the `!` breaking marker.

**What may not go in a hook: typecheck, knip, unit tests, e2e.** Those belong to CI. A slow
pre-commit gets bypassed within a week, and a hook everyone skips is worse than no hook.
The measured gap is the argument: pre-commit is **~95 ms**, while typecheck alone is 367 ms
and knip 453 ms on an empty repository — and both grow with the codebase while a
staged-scoped hook does not.

**The rule that matters most: nothing in `lefthook.yml` may be the only place a check
exists.** Local hooks can always be bypassed and CI cannot. Every hook command names its CI
counterpart in a comment beside it, and the pairing is asserted:

| hook command | CI counterpart |
|---|---|
| `biome` | `static` job — `biome ci .` |
| `docs-freshness` | `docs-freshness` job, against the PR diff |
| `commitlint` | `pr-title` job — the same config file, so the two cannot drift |

Hooks are fast feedback. CI is the guarantee.

### D62. Required checks, and what "merge-blocking" means
Presence of a job in `ci.yml` is not the same as it blocking a merge. The pairing rule in
D61 — that no hook may be the only place a check exists — is only true if the CI
counterpart actually gates the merge button.

The following are **required status checks** on `main`, configured in repository settings
rather than in the workflow file, because GitHub takes them from branch protection and not
from the YAML:

| check | job |
|---|---|
| PR title | `pr-title` |
| typecheck / lint / dead code / docs | `static` |
| unit tests | `unit` |
| integration tests | `integration` |
| pack validation | `publish-shape` |
| changeset present | `changeset` |
| source changed without documentation | `docs-freshness` |

Plus: squash merge only, linear history required, force-pushes and deletions blocked.

Because this cannot be expressed in a workflow file, it is committed as
`scripts/protect-branch.sh` with a runbook, so creating the remote is two commands rather
than one command plus a thing someone remembers:

```bash
gh repo create <your-account>/transport-io --private --source=. --push
./scripts/protect-branch.sh
```

The script also sets `squash_merge_commit_message=BLANK`, which is the flag people miss:
GitHub otherwise puts the PR description into the commit body, breaking the subject-only
rule in D29 on the only commit that survives a squash.

The seven required contexts must match the CI job names exactly or protection silently
guards nothing, so that pairing is asserted mechanically rather than trusted. The window in
which the rule is asserted-but-not-enforced is now as short as the two commands above.

### D63. Windows: hooks are cross-platform, and CI is what gates anyway
An earlier version of this decision said Windows was unsupported for development. That
was a large conclusion from a small cause — direct `./node_modules/.bin/` paths, which are
`.cmd` shims on Windows — and it locked out contributors for an optimisation worth
milliseconds.

Measured before deciding:

| hook command form | cost | resolves on Windows |
|---|---|---|
| `./node_modules/.bin/biome` | 105 ms | no, `.cmd` shim |
| `npx --no-install biome` | ~250 ms | yes |
| `bun run <script>` | **112 ms** | **yes** |

lefthook does **not** add `node_modules/.bin` to `PATH` — verified directly, a bare
`biome` gives `sh: biome: command not found` — so bare names were never an option. A
package.json script is, because the script runner adds `.bin` to `PATH` itself and
resolves the Windows shims. The indirection costs **7 ms** against a budget with room,
where npx would have cost 144.

So hooks are cross-platform by construction and Windows contributors keep them.

Two honest caveats. Windows is not in CI, so this is unverified rather than guaranteed;
WSL is the tested path. And this was never load-bearing regardless: by D61, hooks are
convenience and CI is the guarantee, so a contributor whose hooks did not run could still
develop, commit and open a pull request with every gate enforced. Scoping the decision to
what is actually true costs nothing and excludes nobody.

### D64. Node 22 is the development floor, and the local environment now matches
`engines: >=22`, and the local toolchain was Node 20.20.2 — a warning on install and a
wrong-environment bug the moment integration tests load the transport. Resolved before the
framer rather than after: Node 22.23.2 installed and set as the default.

The ADR 0006 runtime-split evidence (Bun segfault 3/3, Node 0/3) was gathered on Node 20 and
is re-run on Node 22 as part of Phase 2b, per the audit finding `runtime-evidence-is-eol-node`.

### D65. The soak failed. Stream churn leaks 11.6 KB per call stream, upstream.
Run on 2026-08-26, darwin-arm64, Node 22.23.2, 500 concurrent sessions. **It did not
reach the first post-warmup sample**: RSS went from 226 MB to a 3.9 GB JavaScript heap OOM
in 2.8 minutes.

Bisected rather than guessed:

| scenario | heap per bidirectional stream |
|---|---|
| transport-io over the loopback | 0.045 KB |
| transport-io over the real transport | 11.8 KB |
| **the binding alone, no transport-io at all** | **11.76 KB** |
| datagrams over the real transport | flat — 20,000 emits, 0.6 KB total |

The leak is **upstream and unbounded**. It is not ours: transport-io over a loopback is
flat over 20,000 calls, and the binding on its own leaks the same amount with none of our
code in the picture. It is per **bidirectional stream**, not per message — 20,000 datagrams
plateau at 112 MB while 4,000 calls climb without pause. A 16,000-stream run is linear
throughout with no plateau, so it is a leak rather than a bounded cache.

**Practical impact.** At 11.6 KB per stream, the 4 MB/h bound allows 353 streams per hour —
about one call every ten seconds. At ten calls per second it is 408 MB/h; at a hundred,
4 GB/h.

**This is a Stage 1 blocker and the graduation criteria are not met.** Nothing is published
until it is resolved. Recording it plainly rather than adjusting the bound, because the
bound is not what is wrong.

**What it does not invalidate.** D2 remains correct as a design: a stream per call is why a
stalled call blocks nothing, and the loopback numbers show the model itself costs 0.045 KB
per call. The cost is entirely in one implementation of one transport, which is exactly the
scenario ADR 0007's seam was built for — a second transport is now a plausible remedy
rather than a hypothetical.

**Options, in the order they should be considered:**
1. **Reported upstream as fails-components/webtransport#503** on 2026-08-26, with the
   per-side split and a self-contained reproduction that was run as written before posting.
   It is a sharper report than the existing #425, which measures 500 MB to 700 MB over
   twelve hours with a full application; this is 181 MB over sixteen thousand streams in
   about two minutes with no application code.
2. Evaluate the second transport behind the seam (`@moq/web-transport`, a NAPI binding over
   a Rust QUIC stack) against the same probe.
3. Neither of these is a reason to change the protocol. A stream per call stays.

`scratch/binding-only.node.ts` reproduces it in isolation and should move into the
repository as a pinned regression measurement.

### D66. The leak is on both halves, and the alternative transport is flat
Measured after D65, because "which side leaks" decides whether this blocks v1: in
production the client is a browser using its own WebTransport and never touches this
binding, while the binding is the long-lived server.

**Both halves leak, near-equally.** Two processes, each reporting only its own memory,
6,000 streams:

| side | heap per bidirectional stream |
|---|---|
| client (a browser never runs this) | 5.88 KB |
| **server (the long-lived process)** | **5.95 KB** |
| sum | 11.83 KB, matching the 11.76 KB single-process figure |

So the single-process number was two roughly equal halves, and **the server half leaks.
This remains a Stage 1 blocker**, at half the severity: 5.95 KB per stream allows 688
streams per hour under the 4 MB/h bound, about one call every five seconds, and costs
209 MB/h at ten calls per second.

**The alternative transport is flat.** The identical probe, identical counts, against
`@moq/web-transport` 0.1.4 (a NAPI-RS binding over a Rust QUIC stack):

| transport | per stream, 16,000 streams |
|---|---|
| reference binding | 11.60 KB, linear, no plateau |
| **`@moq/web-transport`** | **0.01 KB** — heap 7.7 → 7.9 MB, RSS plateaus at 82 MB from stream 7,000 |

That is not a smaller leak, it is the absence of one: the plateau is the tell.

**ADR 0007's seam has paid for itself.** It was justified in principle a week ago and is
now the difference between shipping `call()` and not. The protocol does not change; one
implementation behind an interface does.

**The honest costs of adopting it**, none of which are reasons not to:

- Its quirks will be different quirks. The swallowed `tooBig` and `blocked`, the missing
  `streamErrorCode` and the reliability guard are *this* binding's defects. Expect a fresh
  set, and expect `resetCodeFromError` to need a sibling — its `reset(code)` and
  `stop(code)` take explicit codes, so the message-parsing may not be needed at all.
- **It ships raw TypeScript as its only entry point.** `exports` is `{ ".": "./src/index.ts" }`
  with no compiled JavaScript, and Node refuses to strip types inside `node_modules`, so
  `import ... from '@moq/web-transport'` fails with
  `ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING`. The subpath is not exported either, so the
  native binding is reachable only by file path. Adopting it means bundling, requiring by
  path, or persuading upstream to ship JavaScript. This is an adoption cost, not a defect
  in the QUIC stack.
- It is version 0.1.4 and young. The reference binding is 1.6.7 with four years of history.
- Install is *better*: per-platform npm optional dependencies rather than a
  `prebuild-install` fetch from GitHub Releases, so F1's supply-chain caveat goes away.

### D67. What happens to v1 if both transports leak
Decided in advance rather than discovered, per the rule that a decision made while standing
in the problem is not a decision.

**Condition:** the server half leaks above the 4 MB/h bound on every transport we can
adopt.

**Then: ship v1 with `call()` present and the leak documented on the box.** Not removed,
not silently budgeted.

- Removing `call()` would give a smaller but honest v1, and it is the tempting option. It
  is wrong, because `emit` and datagrams are provably flat and `call()`'s design is
  provably sound — the loopback costs 0.045 KB per call. Deleting a correct feature to
  route around one implementation's defect is the wrong shape of fix, and it makes the
  protocol a hostage to a dependency.
- Shipping with a budget of 353 streams per hour and saying nothing is not a product.
- Blocking indefinitely on an upstream fix leaves working code unshipped for a reason
  outside our control.

So `call()` ships, the README carries the leak in the limitations section above the install
instructions with the measured number and the transport it applies to, and the transport
seam is documented as the escape hatch. That is consistent with everything else here: state
the guarantee, including when the guarantee is bad.

**This condition is currently NOT met** — `@moq/web-transport` is flat — so this decision
is on the shelf rather than in force.

### D68. moq is not adoptable yet, and the reason is not memory
The byte count in D66 established one property. Running the existing suite against it
behind the seam established the rest, and the rest is where the answer changed.

**What works.** Verified by hand under plain `node`, full transport-io stack over moq:
session establishment, the handshake, both lanes, `call()` with half-close and response,
and caller-side abort. `maxDatagramSize` reports 1413, higher than the reference binding's
1211. Both bindings import and bind in the same process.

**Quirk diff, which is what the exercise was for:**

| behaviour | fails-components | moq |
|---|---|---|
| per-stream heap | 5.95 KB server / 5.88 KB client | **0.01 KB, flat** |
| `maxDatagramSize` | 1211 | 1413 |
| reset code recovery | message-string parsing only | **explicit `reset(code)` / `stop(code)`** |
| abort reaches `ctx.signal` | yes, after the fix below | **no** |
| oversized datagram | accepted, discarded, reports success | our layer refuses first either way |
| reliability attribute | present | absent — correct, it is HTTP/3 only |
| entry point | normal | **raw TypeScript, unimportable from Node** |

`resetCodeFromError` becomes unnecessary on moq: `reset` and `stop` take a numeric code
directly, so the message parsing that exists only to work around a dropped
`streamErrorCode` has nothing to do. It stays for the reference transport.

**Three blockers, in order:**

1. **The file-path import.** Reaching past a dependency's `exports` map to an internal
   file means a patch release can move it and break consumers with no semver signal. That
   is not a supply chain to put under v1, however flat the memory profile is. Filed as
   moq-dev/web-transport#388 with all three failure modes verified before posting.
2. **Abort does not reach the responder.** moq surfaces STOP_SENDING only on the next
   write, and a long-running handler never makes one, so `ctx.signal` never fires. The
   caller still rejects, so the API is not broken — but the work carries on, which is half
   of what abort is for.
3. **An unresolved hang under `node --test`.** The identical flow passes under plain
   `node`, and the module loads and binds fine under the runner, so the cause is somewhere
   in the session flow in that context. Not root-caused. The parity test is `skip`ped with
   this reason attached rather than deleted or left to hang.

**So: not adopted, not rejected.** The memory result is necessary and not sufficient, and
saying otherwise would be treating one measurement as the whole decision.

### D69. A bug the parity work found in our own code
`ctx.signal` never fired on the responder, on either transport. `#serveCall` reads the
request to completion and then invokes the handler, at which point nothing is watching the
stream, so a peer reset arriving afterwards reached nobody.

This matters beyond the bug: ADR 0002, the README and API.md all claim the responder's
signal fires without the client sending anything. That claim was false for as long as it
has been written down, and every test passed because none of them asserted the responder
side of an abort — they asserted the caller rejected, which it always did.

Fixed by watching `writer.closed`, which rejects when the peer sends STOP_SENDING. Now
true on the reference transport, and asserted in both directions in the parity suite so it
cannot silently regress.

**The lesson is about the test, not the fix**, and it has now cost us twice.

A bug lives in the path the quick test skips. Both times, every test passed and the missing
coverage was invisible because the tests that existed looked thorough:

| bug | what every test did | what none of them did |
|---|---|---|
| `ctx.signal` never fired on the responder | asserted the **caller** rejected | asserted the **responder** observed it |
| `NapiServer.close()` deadlocks (D71) | ended with `process.exit(0)` | called `stop()` and waited |
| `connectHttp3` never awaited the native load | ran a client **beside a server** | ran a client **alone** in a process |

The shape is identical in all three: the suite exercised the convenient half of a two-sided
interaction — the initiating half, the exiting half, the co-located half — and the defect
sat in the half that was skipped for convenience. Not one of them was a subtle bug. Each was
a total failure of a documented guarantee, surviving a green suite.

**The standing rule.** For anything two-sided — caller and responder, startup and shutdown,
client process and server process — a test asserts *both* sides or it tests neither. When a
test takes a shortcut at the end (`process.exit`, a shared process, a skipped teardown),
that shortcut is the specification of what it does not cover, and it is worth writing down
next to the shortcut. `client-standalone.node.test.ts` carries exactly such a note, because
the moment someone adds a server to that file it silently stops testing anything.

### D70. moq's native packages are a legitimate dependency; the entry point is not
Path (b) evaluated. All five per-platform NAPI packages are published independently on
npm at 0.1.4, each with `main` pointing at its own `.node` binary and matching `os`/`cpu`
fields:

```
@moq/web-transport-darwin-arm64      0.1.4    main: web-transport.darwin-arm64.node
@moq/web-transport-darwin-x64        0.1.4
@moq/web-transport-linux-x64-gnu     0.1.4
@moq/web-transport-linux-arm64-gnu   0.1.4
@moq/web-transport-win32-x64-msvc    0.1.4
```

`require('@moq/web-transport-darwin-arm64')` returns all seven NAPI classes. That is a
package's **declared entry point**, not a reach past someone's `exports` map into internal
layout, so the objection in D68 does not apply and no upstream cooperation is needed.

Declared as `optionalDependencies`, pinned exactly; npm installs only the matching
platform. The adapter selects by `${process.platform}-${process.arch}` and raises
`WT_NO_SUPPORT` naming the package for anything else.

**Wrapper size: 290 lines**, against 236 for the reference adapter. A wrapper, not a
project. Verified working through it: stream lane, datagram lane, and `call()`.

This resolves the packaging blocker. It does not resolve D71 or the abort question.

### D71. moq's server cannot be shut down: `close()` deadlocks
Root-caused, not worked around. Minimal reproduction with no transport-io involved, kept
at `packages/core/src/bench/moq-close-deadlock.node.ts`:

```
bind -> close()                      -> close() returns, process exits
bind -> accept() pending -> close()  -> close() NEVER RETURNS
```

`NapiServer.close()` blocks forever when an `accept()` is outstanding. A server that
accepts connections always has one outstanding, so **a moq server has no graceful
shutdown**. It must be killed.

This is what the `node --test` hang was. The suite reaches teardown and blocks on
`listener.stop()`. Every standalone probe missed it by ending with `process.exit(0)` rather
than stopping the listener. That is not a fact about moq — it is the third instance of the
pattern recorded in D69, and it belongs there.

No workaround is available here: a pending native promise cannot be cancelled, and the
deadlock is in a synchronous native call, so no JavaScript watchdog can rescue it.

### D72. `ctx.signal` stays a guarantee, so moq is not adoptable
The question was: drop the guarantee from the documentation, make it per-transport and
state it, or hold moq until it propagates. **Hold moq.**

Per-transport was the tempting answer and it is wrong. This library's entire thesis is that
a guarantee is a property of the contract rather than of the deployment — D1 puts the lane
in the contract precisely so that what a message promises does not vary with how it is
carried. A capability that silently depends on which transport an operator chose is the
same failure in a new place, and D69 exists because this exact guarantee was documented and
false once already. Making it conditionally false is not a repair.

Dropping it from the documentation is worse: it removes a real, working capability on the
transport actually shipped, to accommodate one that is not.

So `ctx.signal` remains an unconditional guarantee, and a transport that cannot deliver a
peer reset to the responder does not qualify. moq currently cannot.

### D73. Transport decision: stay on the reference binding, D67 in force
Three paths were on the table. (b) removed the packaging blocker and the memory result is
genuinely much better — flat against 5.95 KB per stream server-side. It is still not
adoptable, for two reasons that are about correctness rather than performance:

- **No graceful shutdown** (D71). A server that must be killed cannot drain connections.
- **Abort does not reach the responder** (D72). Cancelling a call leaves the work running.

Against that, the reference binding leaks 5.95 KB per server-side stream (D65, reported
upstream) but shuts down cleanly and propagates aborts correctly.

**So D67 goes into force:** ship with `call()` present and the leak documented in the
README above the install instructions, with the measured number and the transport it
applies to. The moq adapter stays in the tree behind the seam, with its two blockers
recorded and reproductions committed, because the moment either is fixed this becomes a
config change rather than a migration. That is what the seam was for, and it has already
paid for itself by making this a comparison rather than a guess.

**Reconsider when:** `NapiServer.close()` returns with an accept pending, and a peer reset
reaches the responder. Both are checkable by running the committed benches.

### D74. Nothing outsider-controlled is ever interpolated into a `run:` block
`${{ ... }}` in a workflow is not a shell variable. GitHub substitutes it into the script
*text* before any shell parses it, so an expansion whose value an outsider writes is
arbitrary code on the runner.

The repository shipped one:

```yaml
- run: echo "${{ github.event.pull_request.title }}" | npx commitlint
```

A pull request title is written by whoever opens the pull request. A title containing
`"; <command>; echo "` closes the string and runs the command on a runner that already has
the repository checked out, the dependency tree installed and network egress — before a
human has read the PR. The workflow also declared no `permissions:`, so that command
inherited whatever the repository default grants.

**Every context expansion goes through `env:` and is referenced as `"$NAME"`**, and every
workflow states its minimum `permissions:` at the top. `contents: read` is the whole
requirement here; nothing in CI writes to the repository.

The rule is absolute rather than an allowlist of contexts believed safe, and that is the
decision rather than an accident of strictness. `github.base_ref` is safe today only
because branch protection fixes the base branch — a setting somebody can change, not a
property of the expression. `env:` is safe for a reason nobody can revoke: the shell
receives the value as data and never re-parses it as script. An allowlist would have to be
re-audited every time GitHub adds a context or the repository changes a setting; this does
not.

Enforced by `scripts/check-workflows.ts` in the `static` job, which fails on any `${{` in a
`run:` block (inline or block scalar) and on any workflow with no top-level `permissions:`.
It is line-based and takes no YAML dependency on purpose: adding a parser to catch a
supply-chain problem is its own supply-chain problem.

**Reconsider when:** never for the `run:` rule. The `permissions:` rule relaxes only if a
job genuinely needs to write, and then it states the wider scope on that job alone rather
than at the top.

### D75. A code that nothing sends is deleted, not documented harder
Eleven of the codes defined in `protocol.ts` and tabulated in `PROTOCOL.md` §10 were
transmitted by no code path at all. `CloseCode` appeared in **zero** test files. Four of
them were also restated as normative promises in an ADR and in `AGENTS.md`, and three had a
test whose *name* was the promise and whose body asserted something cheaper to reach.

Each one was decided separately, because "the docs are ahead of the code" has two opposite
remedies and defaulting to either is how the gap got here.

**Built, because a second implementation genuinely needs them.**

| code | why it had to exist |
|---|---|
| `1000` `WT_PROTOCOL_VERSION_MISMATCH` | Every refusal closed with `1004` = "unrecoverable framing violation". A peer told that debugs a framing bug that is not there, and one that retries on `1004` retries forever against a disagreement that will never resolve. |
| `1001` `WT_CONTRACT_MISMATCH` | Same, and the remedy differs: redeploy both sides, not fix your framing. |
| `1006` `WT_RELIABILITY_REFUSED` | The client threw and left without closing, so the peer held a session this side had already abandoned with nothing on the wire to say why. |
| `9` `WT_TOO_MANY_STREAMS` | `#openCalls` counted only *our* opens. The cap protected the peer from us and did nothing about a peer opening 10,000 — which is the case a cap is for. Now refused **before the request is read**, since the cost being bounded is the decoder, the handler and the 16 MiB the decoder will buffer. |

**Deleted, because the implementation was right and the table was fiction.** Reset codes
`2`–`8` — handler error, protocol error, unsupported codec, payload too large, handshake
incomplete, unknown event, validation failed. Every one of these is a *call* failure, and
this implementation already reports call failures as a `CALL_ERROR` frame carrying a code
**and a message**, on the stream the call already owns. A reset carries one byte. Keeping
the table would have meant implementing a strictly worse channel to satisfy a document.
The names survive as `TransportErrorCode`s, which is what they always actually were.

**The mechanism, which is the part that matters.** A promise nobody can observe failing is
not a promise, so `protocol-promises.test.ts` asserts each of these **on the wire** — the
close code a peer receives, not the `TransportError` this side raised — and a scan there
fails if any defined code is named by no non-test code path. Its exemption list may only
shrink, and it is honest about its limit: it proves a code is *referenced*, not that the
reference is reachable. `WT_PEER_TOO_SLOW` is referenced and its branch is dead, which is
D76's problem and needs a behavioural test rather than a scan.

**Reconsider when:** a call failure needs to be signalled where no stream is left to write
on. That is the only thing a reset buys, and it is why code `9` survived.

### D76. Teardown is a half nobody drove, so it is measured now
Three defects, all on the disconnect half of a lifecycle every test only ever connected.

**The Session outlived its connection.** `clearInterval` appeared in exactly one place,
`Session.close()`, and neither teardown path called it: the server's `conn.closed`
continuation freed the origin and removed the peer, the client's patched a snapshot. So
whichever side did not *initiate* a close kept a live `setInterval` whose callback closes
over `this` — retaining the Session, its Connection, the frame decoder, both queues, the
sequence gate and every handler set. `unref()` was there and gave false comfort: it stops a
timer holding the event loop open, not holding memory.

Fixed by `Session.dispose()`, idempotent and wired to `conn.closed` inside `start()` rather
than left for callers. A cleanup a caller must remember is one a caller will forget, and
both callers had.

**An adapter rejection abandoned teardown.** `Hub.removePeer` awaited `adapter.leave` inside
the room loop with no `try`, while `broadcast` had wrapped its adapter call all along. A
rejection on the first room threw out of the loop: rooms 2..N kept a `Member` record each
holding a live Session, `#peerRooms.delete(id)` never ran, and nothing retried because
`conn.closed` resolves once. The caller attached no `.catch`, so it was also an unhandled
rejection — which ends a Node process by default, the exact opposite of the "core degrades
rather than crashing" that ADR 0005, D40 and `API.md` all promise. Local state is now
unconditional and the bus is told with `Promise.allSettled`: the peer's connection is
already gone, and a bus that cannot be told now will not be told by us failing here.

**A join rejection left a peer half-joined.** `Hub.join` mutated `#rooms` and `#peerRooms`
*before* awaiting the adapter, with no rollback and no notification. On rejection the hub
fanned broadcasts to a peer the bus had no record of, and the client was never told it had
joined — permanently. For a room gated on authorization that is traffic reaching someone
who was refused. The adapter call now happens first; local state follows it.

**The test that named this and did not test it.** `adapter-conformance.test.ts` had a case
titled *"join rejecting does not leave the peer half-joined from core's view"* asserting
only that the client was still `connected` — true whether or not the peer is half-joined.
`HostileAdapter.failNextJoin` and `failNextLeave` exist for precisely these cases and were
set by **no test in the repository**. This is D69's shape in a test written after D69.

**Why the soak could not have caught any of it, and what replaces that.** `soak.node.ts`
never disconnects a session. `soak:churn` does, and the number it reports is bytes retained
per session churned by linear fit — an absolute quantity, per D13's rule.

Its warmup is **wall clock, not a cycle count**, and that detail is the whole measurement.
`ORIGIN_QUARANTINE_MS` is 120 s: a freed origin is deliberately held for two minutes before
reuse, so a run shorter than the window measures quarantine occupancy as though it were a
leak. 12,000 cycles take 17 seconds, so no cycle count can express "past the window". The
first draft reported +402 B/session and the second +72 B, both of them quarantine and
start-up allocation rather than leak. Warming up for 130 s and then fitting over 12,000
cycles reports **−2 B/session** across 85,783 cycles, with heap flat at 9.6–9.7 MB.

| | retained per session |
|---|---|
| before the fixes | **+15,011 B** — 5.1 GB/hour at 100 sessions/s |
| after, warmup by cycle count (wrong) | +402 B, then +72 B — quarantine, not leak |
| after, warmup past the quarantine window | **−2 B** — flat |

**Reconsider when:** `soak:churn` reports a positive slope, or `ORIGIN_QUARANTINE_MS`
changes — the warmup default is tied to it and has to move with it.
