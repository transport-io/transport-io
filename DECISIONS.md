# DECISIONS

Every question this project has raised, each one answered. There is deliberately no
open-questions file. A decision may be provisional, but it is never absent: where
certainty is impossible before implementation, the entry records a chosen default plus
the specific observable trigger that would make us revisit it.

Status: Phase 1a in progress. Entries below are settled unless marked OPEN.

---

## Part 1 - Fixed design decisions (from the kickoff, not relitigated)

> **These rows are the kickoff as it was written and are not updated in place.** Two have
> since moved: D1's lane values are now `reliable` and `unreliable` (D92), and `stream()` is
> shipped rather than a non-goal (D93). The rows below keep their original wording because
> this table is a record of what was decided, not a description of the current API. For that,
> read `API.md`.

| id | decision |
|----|----------|
| D1 | **lane-in-contract.** Events declare `stream` or `datagram` at contract-definition time. The lane is a property of the message type, never of the call site. |
| D2 | **streams-as-acks.** Each `call` opens its own bidirectional stream: write request, half-close to end it, read response until the peer closes. No correlation IDs, no pending-callback map, no ack bookkeeping. A stalled call cannot block another call. |
| D3 | **no-fallback.** WebTransport only. No WebSocket fallback, ever, because it would silently make the datagram lane reliable and ordered - a lie about the user's data. |
| D4 | **new-session-on-reconnect.** Reconnect creates a new session. Room membership does not survive it. `session` event carries `{ id, resumed }`; `resumed` is hardcoded `false` in v0.1 so real resume can arrive later as a `feat` flag rather than a redesign. |
| D5 | **adapter-boundary.** Pub/sub adapter interface. Frames cross it as bytes, never live objects. Every method is async. `PeerId` is a stable cross-process string. Core never assumes it knows a room's full membership. `MemoryAdapter` ships in core as the default; Redis is not in v1 and core must never reference it. |
| D6 | **abort-via-stream-reset.** `call()` and `stream()` take an `AbortSignal`; abort maps to a QUIC stream reset. Implemented in v0.1 even though `stream()` ships later. |
| D7 | **multi-frame-response.** A call response is a sequence of frames terminated by stream close, not one length-prefixed frame - so token streaming is addable without a protocol break. |
| D8 | **datagram-lane.** The unreliable lane uses WebTransport datagrams directly. |
| D9 | **serverless-publisher-split.** A write-only `Publisher` (broadcast only, stateless, constructible per invocation) is separated from the full `Adapter`. Session hosting requires a long-running process; that is not designable away. |

Non-goals for v0.1: namespaces, presence/peer counts, middleware chains, binary payloads
(JSON only, codec seam reserved), non-WebTransport transports, framework bindings
themselves, `stream()` and agent helpers, serverless session hosting, the Redis adapter.

---

## Part 2 - Phase 0 verified findings that became requirements

All of the following were verified on this machine or against shipped artefacts, not
relayed from documentation.

### F1. Install friction - smaller than feared, with two sharp edges
`npm install @fails-components/webtransport` is pure JS: 1s, 896K, no native code. The
native transport is a **separate, manually installed** package
(`@fails-components/webtransport-transport-http3-quiche`) loaded by dynamic `import()` -
it is not even an `optionalDependency`, so npm will never pull it in. Installing it took
6s and downloaded a prebuilt binary; no compilation.

- **Prebuilds come from GitHub Releases, not npm.** The dependency is on GitHub
  availability, not just the registry. Pin the transport version exactly and cache the
  download in CI. State this in README requirements - it is a supply-chain fact users
  deserve to know.
- Prebuild matrix is exactly five triplets: darwin-arm64, darwin-x64, linux-arm64,
  linux-x64, win32-x64. **No musl build**, so Alpine falls back to a source compile
  requiring git, cmake and a C++ toolchain.

### F2. glibc 2.38 - the default Docker tags are a trap
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

Disabling it is a hard requirement - see D10 for the enforcement rule.

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
`DATAGRAM`) occur 2-23 times each - so the absence is real, not a search artefact. The
binary advertises only `SETTINGS_WEBTRANS_DRAFT00` and
`SETTINGS_WEBTRANS_MAX_SESSIONS_DRAFT07`; the settings Safari needs
(`WT_INITIAL_MAX_DATA`, `WT_INITIAL_MAX_STREAMS_UNI/BIDI`) are absent. Current
google/quiche `capsule.h` still has `WT_MAX_DATA` commented out and the blocked capsules
under `TODO(b/264263113)`.

The maintainer's position (2026-07-12): *"it is not implemented in quiche, so until they
do, no safari"* - and he will not patch quiche. The only workaround he offers is the
reliable fallback D3 forbids. The fix is proven feasible (quic-go/webtransport-go#261,
+29/-6, merged 2026-06-14) but must land in quiche.

**Consequence: Safari is de facto unsupported in v1.** See D11.

### F11. Upstream defects that become our tests
- **#365** - writing a zero-length `Uint8Array` freezes the server with a `quic_bug`.
  Forbid zero-length frames and datagrams outright (D12).
- **#425** - RSS 500M→700M+ over 12h at 2,500 sessions / 500 concurrent, attributed to
  stream churn. D2 opens a stream per call, maximally exercising it. Promoted to a
  Stage 1 graduation criterion (D13).
- **#5** - outgoing datagrams are never expired despite the spec requiring it, open since
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

## Part 3 - Decisions taken during Phase 1a

### D10. No-fallback is enforced server-side; the client check is defence in depth
The obvious client guard does not work. `requireUnreliable` and `session.reliability` are
both unsupported in Chrome (F9), so asserting `reliability === 'supports-unreliable'`
would refuse **every Chrome session**.

- **Server (the actual guarantee):** construct only `Http3Server`. Never `Http2Server`,
  never `reliability: 'both'`. If our server never listens for H2 extended CONNECT, no
  client can negotiate a reliable-only session with us, whatever its browser supports.
  This is browser-independent and testable, and it is the assertion the e2e suite makes.
- **Client (defence in depth):** set `requireUnreliable: true` - honoured on
  Firefox/Safari, harmlessly ignored on Chrome - and assert
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

We do not merely document it - we detect it. See D16.

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
the measurement is slope, not noise. Run manually before Stage 1, never on PRs - too slow
and too flaky for a merge gate, and it would be disabled within a month.

The threshold was originally 5% growth between two point samples. That was wrong, and wrong
in a way worth recording: against the upstream leak's own 16.7 MB/h, the 50-minute window
yields ~13.9 MB, which at any plausible baseline is 2.8–4.6% - **under the threshold**. The
criterion would have certified the exact leak it was written to catch. A threshold stated
as a proportion of a baseline we do not fix in advance is unfalsifiable, and two point
samples are not a slope.

**The criterion is per lane, because the lanes differ and only one of them fails.**

| lane | requirement | status |
|---|---|---|
| emit (stream) | slope under 4 MB/h | must pass - measured flat |
| datagram | slope under 4 MB/h | must pass - measured flat, 20,000 sends plateau at 112 MB |
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
1. Filename split - `*.node.test.ts` for anything loading the transport, separate
   scripts, CI runs both. A test importing quiche must never be reachable from the Bun
   test task.

   A convention only means something if the runner honours it, and Bun's default glob is
   wider than it looks. It matched `*.node.test.ts` - `bun test` picked up 9 files where
   it should have seen 8, loading the native addon in the runtime that segfaults on it -
   and it later matched the Playwright `*.spec.ts` suite too, which failed with
   `Playwright Test did not expect test() to be called here`.

   The unit script therefore excludes both explicitly, and the exclusion is checked by
   comparing file counts rather than assumed: 14 files unfiltered, 11 filtered. Both
   escapes were the same mistake - assuming a runner's default matches the intent of a
   filename - and a third would be a reason to stop relying on globs entirely.
2. **An import-boundary lint rule** forbidding `@fails-components/*` imports from any
   file not matching `*.node.*`. This fails at typecheck instead of as a segfault that
   looks like flaky CI.

Recorded in `ADR/runtime-split` with the segfault evidence so nobody simplifies it back
to one runtime.

### D15. Backpressure: one policy, three lanes, numbers not adjectives
*The call-stream half of this entry was disproved in 2026-08. It says a stalled consumer
applies flow control through the transport; it does not, and `stream()` carries an explicit
credit window instead. Kept as written, because this is a record. See D93 and ADR 0012.*

The three constraints resolve differently because the lanes make different promises.

- **Datagram lane, per peer:** bounded ring of **64 frames**, drop **oldest** on
  overflow. Oldest-first because every real datagram payload is last-write-wins, so
  stale frames are the ones worth losing. 64 frames is ~1s of buffer at 60Hz. Drops
  increment a counter and never throw: dropping is the lane's advertised contract.
- **Stream lane, room broadcast, per peer:** bounded queue of **256 frames**, then close
  the session with `WT_PEER_TOO_SLOW`. No dropping - a reliable lane that silently drops
  is exactly the lie the thesis forbids, and a peer 256 frames behind is already gone.
- **Token/call streams:** no queue, no drop. Propagate backpressure to the handler by
  awaiting `writer.ready`, high-water mark **16 frames**. This falls out of D2 for free:
  each call owns its own QUIC stream, so a stalled consumer applies flow control to its
  own producing handler and cannot touch another call. "One slow consumer must not stall
  the others" is satisfied by the transport, not by our queueing.
- **Stale datagrams (separate axis from overflow):** a TTL checked at **dequeue**, not
  enqueue. Drop-oldest handles a burst but does nothing for a peer that stalls two
  seconds and resumes - the ring never overflows and we deliver 64 stale cursor
  positions, which is worse than dropping them because the app renders history. Counted
  as `staleDropped`, separate from `overflowDropped`, so the two causes stay
  distinguishable. **TTL is 150ms**, session-wide. It is *not* per-event and there is no
  `ttl: null` escape hatch - an earlier draft of this entry promised both, `EventDef` never
  grew the field, and `DatagramQueue` is constructed with no arguments, so the escape hatch
  for the one case the default gets wrong was unreachable by any means. The promise is
  withdrawn rather than implemented: a per-event knob is a contract-shape change, and no
  measured case has yet needed it. 150ms sits inside the window where
  a late frame is still worth showing: cursor lag is perceptible around 100ms and reads
  as broken by 200ms. The interaction with the ring is what makes it work - a peer
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
Core accepts anything implementing `StandardSchemaV1` - zod, valibot and arktype all ship
it - so core has zero runtime dependency and zero peer dependency. A types-only `type$<T>()`
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
accepting sessions and need a restart - a scheduled outage disguised as a safety property,
arriving in production because it is a function of uptime times load rather than of
anything testable.

Reuse is provably safe because both confusable windows are values this protocol sets: a
receiver discards `(origin, event)` sequence state after 60 seconds idle, and an in-flight
datagram cannot outlive the 150 ms send-queue TTL plus transit. A released origin is
therefore quarantined **120 seconds**, twice the longer bound. Steady-state occupancy
becomes `concurrent + churn × 120s` - 1.4% of the space at 500 sessions/second - so
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
for the bus to echo - lower latency, no dependency on adapter round-trip. Documented
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
Redis - so nothing in v1 can publish across processes. Define the interface, test it
against `HostileAdapter`, keep it internal, and export it when the Redis adapter makes it
real. Same treatment and justification as `Transport` (D21).

### D23. Deployment is not our problem; exactly one fact is library-level
We ship a library. Where someone runs it is their concern, and a vendor matrix is stale
the moment Railway ships UDP. README requirements carries exactly this, next to the Node
version - no vendor names, no flags, no comparison table:

> transport-io requires raw UDP ingress to your process on the port you listen on. Unlike
> TCP, many managed platforms do not provide this. Verify your platform routes UDP before
> building on this.

Everything else - Fly's dedicated-IPv4 and `fly-global-services` details, the AWS NLB
QUIC passthrough path, platforms that currently cannot do it - moves to the example app's
own docs, dated and marked non-normative.

Two items from that research are design record, not deployment notes: Fly's MTU
observation (cited in D19) and NLB's QUIC-Connection-ID stickiness, which is the answer
to connection migration behind a load balancer and belongs in known issues as a technical
note, since a naive 4-tuple-hashing balancer will break sessions when a client changes
network.

---

## Part 4 - Code hygiene decisions

### D24. Hygiene precedes source
The first commit of Phase 2 is tooling and nothing else. CI passes before a single
library file exists. Retrofitting standards onto code written without them is how a
codebase rots, and this one is too young to carry any debt.

**Knip on an empty repo:** the first commit ships a single stub entry per package -
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
- Explicit byte assertions for protocol frames. No snapshot tests - a snapshot records
  whatever the code did, including the bug.
- Tests assert against PROTOCOL.md and API.md, never internal structure.
- Never mock the thing under test. Adapter tests run against `HostileAdapter`.
- Type-level tests proving a wrong event name or wrong payload fails to compile.
- No coverage threshold. Coverage targets manufacture exactly the self-satisfying tests
  being avoided. Review test quality instead.

### D28. E2E from Phase 2a, not Phase 3
Real browser, real server process, real certificate. Playwright driving Chrome against a
spawned Node server using the self-signed certificate hash flow. The minimal harness
arrives in **Phase 2a** - two pages, one server, the two-context room test as soon as
there is a room to test. The Phase 3 example app becomes the fixture by **replacing** the
harness, not by introducing e2e for the first time. Runs on every PR. A flaky e2e test
gets fixed or deleted, never wrapped in a retry loop.

Canonical test: two browser contexts join one room, one message on each lane, both
contexts receive.

### D29. Commit conventions enforced at both gates
We squash merge, which changes where enforcement matters.

- **PR title is the squashed commit subject**, so the PR title lint gate is load-bearing.
  It is the thing that protects the changelog.
- **The PR body does NOT become the commit body.** An earlier draft of this entry said it
  did and told authors to write `BREAKING CHANGE:` footers there. Three things contradict
  it: `body-empty` and `footer-empty` in `commitlint.config.ts`, D29's subject-only rule,
  and `squash_merge_commit_message=BLANK` in `scripts/protect-branch.sh`, which discards the
  body at merge. The `pr-title` job pipes only the title, so a footer written in the body
  was never linted *and* never landed. Breaking changes use the `!` marker in the subject,
  which is the only part that survives; the rationale goes in the changeset or the ADR.
- The pre-commit hook stays, but its real job is fast local feedback and keeping the
  branch readable during review. Individual commits are squashed away, so the hook is a
  nicety and the PR title gate is the guarantee. The hook does not make the PR gate
  redundant.
- Same commitlint config for both so they cannot drift.
- Repository settings: squash merge only, linear history required, both gates required.

**Scopes are required, not optional:** `feat(core):`, `fix(ci):`, `chore(repo):` - validated
against the workspace list in `commitlint.config.ts`, which is `core`, `ci`, `docs`, `deps`,
`repo`. (`fix(react):` appeared here as an example for a package that does not exist, and
would have been rejected by the gate this very entry describes.)
transport-io gets its own commitlint config; the global `^[A-Za-z0-9 ,:]{4,72}$` subject
rule from another of this author's projects does not travel here. Parentheses are allowed, and the scope is validated
against the actual workspace package list so `feat(cor):` fails.

**Subject only, never a body.** No commit has a body - not for rationale, not for
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
dist-tag on merge to main. Nothing reaches `latest` until Stage 1 - so **Stage 1 begins
at the first stable publish, not the first publish of any kind.**

### D31. CI on every PR
One workflow, all required to merge, fast checks first: typecheck, Biome, knip, Bun unit
tests, Node integration tests, Playwright e2e, changeset presence.

---

## Part 5 - Decisions from Phase 1a batch two

### D32. Stream-lane `emit` uses one long-lived unidirectional stream per direction
Not one stream per emit. Emits are fire-and-forget, and ordered-within-lane is the
guarantee chat actually wants. One stream per emit would multiply the #425 stream-churn
leak by message volume and add stream-ID accounting per message. `call` gets its own
stream precisely because isolation is the point *there*.

Emit payloads are capped at **1 MiB**; anything larger belongs in a `call`.

**Accepted cost, stated plainly because it is easy to miss: the head-of-line blocking is
cross-room.** All rooms share one emit stream per direction, so a busy room delays a quiet
room's messages to the same peer. That is the problem this transport is sold as solving,
reintroduced on the lane most apps will use most. The trade is still right - per-room
streams would multiply #425 churn by room count, and `call` plus datagrams stay isolated -
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
  silently - exactly the unreliable lane's advertised contract. No error, no new rule.
- **`call` bidi streams** can still race. The server answers on that stream with a
  call-error frame and resets it. No session close; it reuses the error path that already
  exists.

**Deadline: 5000ms in both directions**, producing `WT_HANDSHAKE_TIMEOUT`. A peer that
never opens its emit stream is indistinguishable from one that never handshakes, so the
same deadline covers both - and this is what converts Safari's silent hang (F10, D11)
into a named error whose message states the likely cause.

The cost accepted: a version mismatch is refused after a stream reader is allocated
rather than before. That is one reader, against removing a race from the protocol.

### D34. Version negotiation semantics
The handshake frame carries `{ v: <integer>, feat: <string[]> }`.

- `v` is the protocol major. **Stage 0: both sides require exact equality and refuse
  otherwise** - the mechanism exists, the compatibility promise does not.
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
rather than a pipeline - if clients could self-join, every app would need to validate room
names on a join path, which is middleware wearing a different hat. An app that genuinely
wants client-initiated subscribe routes it through a `call` handler, which is already the
authenticated path. This also matches the reference: Socket.IO rooms are
[server-authoritative](https://socket.io/docs/v4/rooms/).

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
always-invalid means a zero-filled buffer can never parse as a valid frame - free
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

## Part 6 - Sweep decisions (requirements found unmapped, now resolved)

A mechanical pass over the kickoff prompt, the hygiene addendum and both review replies,
listing every requirement, constraint or finding with no numbered decision. Each is
resolved here rather than left as an implementation assumption.

### D39. Project lifecycle and graduation criteria
**Stage 0 (now, unpublished):** breaking changes are free and expected. No backward
compatibility of any kind, no deprecation paths, no compatibility shims, no migration
guides, no version checks against an older release - there is no older release. Rename
freely, including package names, exports and file layout. The protocol is v0 and unstable.

**Stage 1 begins at the first *stable* publish, not the first publish of any kind** (D30
puts canary on `latest`-free `canary` from day one). At Stage 1 everything inverts: semver
applies, the protocol version becomes a promise, and breaking changes need a major bump
plus a migration note.

**Graduation criteria - all six, so this is a decision and not a vibe:**
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
forbid core from referencing it - and an empty package would trip knip, add a changeset
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
The target reader is someone writing a Go server with no access to our source.

It must **explicitly state what is not guaranteed on the datagram lane** - not imply it,
not leave it to inference.

**Erratum.** This entry originally continued: "Socket.IO's real sin was an undocumented
custom protocol only their own client could speak." That is false. Socket.IO publishes its
protocol at [socket.io-protocol](https://github.com/socketio/socket.io-protocol), at version
5 with a version history, and Engine.IO's at
[engine.io-protocol](https://socket.io/docs/v4/engine-io-protocol/), at version 4.1. The
sentence was cut rather than corrected because the decision does not depend on it: the bar
this entry sets for our document is one theirs already meets. See D110.

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

## Part 7 - Audit resolutions and final pre-implementation decisions

The pre-implementation audit raised 54 findings; 49 were upheld. Full detail in
`AUDIT.md`, which is a historical record rather than a live tracker: every finding in it was
resolved, and the decisions below are where the resolutions live.

### D52. Event identity is a name hash, not a position
An event's wire identifier is the **first four bytes of SHA-256 of its name**, big-endian,
as a `u32`. (Superseded the two-byte `u16` of the first draft - at two bytes one contract in
four collides at 200 events, and the remedy would have been telling a user to rename an
event in their own domain language.) Collisions are a contract-construction error naming both events, resolved by an
explicit `id` that becomes part of the contract.

Positional identity was the original draft and was never recorded as a decision, which is
how it survived unexamined. It fails on contract change: insertion renumbers every later
event, so during a rolling deploy the two halves of a fleet decode each other's traffic
incorrectly rather than failing cleanly. A name hash is a pure function of the name, so two
peers always agree for any name they share, and adding or removing events changes no
existing identifier.

Collision probability is ~0.3% at 20 events, 1.9% at 50, 7.3% at 100 and 26% at 200 -
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

TS 7 removed the classic compiler API - `require('typescript')` returns only
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
`node16`/`nodenext` - creating precisely the hazard ATTW was mandated to catch.

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
canonical by convention. Measured against the README contract: with the interface, `emit`
hover is 107 characters and mentions no schema library. Without it - inline `MapOf<...>` or a
library-supplied `ClientOf<>` alias - it is 377 characters with the validator's internal
types in it, and that is after TypeScript's own elision. The numbers in this paragraph were
originally 126 and 303 and were wrong; see D94.
TypeScript preserves interface names but expands alias instantiations, so no library-side
trick removes the need for the line.

The interface form therefore appears in the README quickstart, in **every** API.md example,
in `examples/chat`, and in `AGENTS.md` when it lands. The inline form appears nowhere. One
sentence in API.md explains why the line exists, because an unexplained magic line is its
own developer-experience problem. The width is enforced by `scripts/check-hover.ts`, which
drives `tsc --lsp --stdio` and measures the hover string an editor would render. This
sentence previously claimed the type-level test pinned it. It did not. See D94.

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
Applied to the documents: the frame length cap corrected (`Length` excludes itself, as its
own minimum already implied) and the §7.1 datagram diagram redrawn against the budget table.
Both numbers moved again when the event id widened to four bytes - the cap is now `1048584`
and `MIN_LENGTH` is 9, the datagram header 13 bytes - which is why every one of them is
asserted against `protocol.ts` by `scripts/check-docs.ts` rather than restated here where it
would go stale a third time; `JOIN` and `LEAVE` added to the `0x0000`
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
`(overflowDropped + staleDropped) / enqueued` over a 60-second window - both counters this
library owns. ADR 0002's trigger, previously the unfalsifiable "stream churn becomes the
dominant cost", now fires on the D13 slope or p99 call latency above 50 ms at 500
concurrent sessions.

Clean: the instantiation budget, the consumer TypeScript floor, the emit-lane latency
trigger, and every queue bound - all absolute. The 89.96% figure is a cited statistic, not
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
and knip 453 ms on an empty repository - and both grow with the codebase while a
staged-scoped hook does not.

**The rule that matters most: nothing in `lefthook.yml` may be the only place a check
exists.** Local hooks can always be bypassed and CI cannot. Every hook command names its CI
counterpart in a comment beside it, and the pairing is asserted:

| hook command | CI counterpart |
|---|---|
| `biome` | `static` job - `biome ci .` |
| `docs-freshness` | `docs-freshness` job, against the PR diff |
| `commitlint` | `pr-title` job - the same config file, so the two cannot drift |

Hooks are fast feedback. CI is the guarantee.

### D62. Required checks, and what "merge-blocking" means
Presence of a job in `ci.yml` is not the same as it blocking a merge. The pairing rule in
D61 - that no hook may be the only place a check exists - is only true if the CI
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
was a large conclusion from a small cause - direct `./node_modules/.bin/` paths, which are
`.cmd` shims on Windows - and it locked out contributors for an optimisation worth
milliseconds.

Measured before deciding:

| hook command form | cost | resolves on Windows |
|---|---|---|
| `./node_modules/.bin/biome` | 105 ms | no, `.cmd` shim |
| `npx --no-install biome` | ~250 ms | yes |
| `bun run <script>` | **112 ms** | **yes** |

lefthook does **not** add `node_modules/.bin` to `PATH` - verified directly, a bare
`biome` gives `sh: biome: command not found` - so bare names were never an option. A
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
`engines: >=22`, and the local toolchain was Node 20.20.2 - a warning on install and a
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
| datagrams over the real transport | flat - 20,000 emits, 0.6 KB total |

The leak is **upstream and unbounded**. It is not ours: transport-io over a loopback is
flat over 20,000 calls, and the binding on its own leaks the same amount with none of our
code in the picture. It is per **bidirectional stream**, not per message - 20,000 datagrams
plateau at 112 MB while 4,000 calls climb without pause. A 16,000-stream run is linear
throughout with no plateau, so it is a leak rather than a bounded cache.

**Practical impact.** At 11.6 KB per stream, the 4 MB/h bound allows 353 streams per hour -
about one call every ten seconds. At ten calls per second it is 408 MB/h; at a hundred,
4 GB/h.

**This is a Stage 1 blocker and the graduation criteria are not met.** Nothing is published
until it is resolved. Recording it plainly rather than adjusting the bound, because the
bound is not what is wrong.

**What it does not invalidate.** D2 remains correct as a design: a stream per call is why a
stalled call blocks nothing, and the loopback numbers show the model itself costs 0.045 KB
per call. The cost is entirely in one implementation of one transport, which is exactly the
scenario ADR 0007's seam was built for - a second transport is now a plausible remedy
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
| **`@moq/web-transport`** | **0.01 KB** - heap 7.7 → 7.9 MB, RSS plateaus at 82 MB from stream 7,000 |

That is not a smaller leak, it is the absence of one: the plateau is the tell.

**ADR 0007's seam has paid for itself.** It was justified in principle a week ago and is
now the difference between shipping `call()` and not. The protocol does not change; one
implementation behind an interface does.

**The honest costs of adopting it**, none of which are reasons not to:

- Its quirks will be different quirks. The swallowed `tooBig` and `blocked`, the missing
  `streamErrorCode` and the reliability guard are *this* binding's defects. Expect a fresh
  set, and expect `resetCodeFromError` to need a sibling - its `reset(code)` and
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
  provably sound - the loopback costs 0.045 KB per call. Deleting a correct feature to
  route around one implementation's defect is the wrong shape of fix, and it makes the
  protocol a hostage to a dependency.
- Shipping with a budget of 353 streams per hour and saying nothing is not a product.
- Blocking indefinitely on an upstream fix leaves working code unshipped for a reason
  outside our control.

So `call()` ships, the README carries the leak in the limitations section above the install
instructions with the measured number and the transport it applies to, and the transport
seam is documented as the escape hatch. That is consistent with everything else here: state
the guarantee, including when the guarantee is bad.

**This condition is currently NOT met** - `@moq/web-transport` is flat - so this decision
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
| reliability attribute | present | absent - correct, it is HTTP/3 only |
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
   caller still rejects, so the API is not broken - but the work carries on, which is half
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
side of an abort - they asserted the caller rejected, which it always did.

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
interaction - the initiating half, the exiting half, the co-located half - and the defect
sat in the half that was skipped for convenience. Not one of them was a subtle bug. Each was
a total failure of a documented guarantee, surviving a green suite.

**The standing rule.** For anything two-sided - caller and responder, startup and shutdown,
client process and server process - a test asserts *both* sides or it tests neither. When a
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
than stopping the listener. That is not a fact about moq - it is the third instance of the
pattern recorded in D69, and it belongs there.

No workaround is available here: a pending native promise cannot be cancelled, and the
deadlock is in a synchronous native call, so no JavaScript watchdog can rescue it.

### D72. `ctx.signal` stays a guarantee, so moq is not adoptable
The question was: drop the guarantee from the documentation, make it per-transport and
state it, or hold moq until it propagates. **Hold moq.**

Per-transport was the tempting answer and it is wrong. This library's entire thesis is that
a guarantee is a property of the contract rather than of the deployment - D1 puts the lane
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
genuinely much better - flat against 5.95 KB per stream server-side. It is still not
adoptable, for two reasons that are about correctness rather than performance:

- **No graceful shutdown** (D71). A server that must be killed cannot drain connections.
- **Abort does not reach the responder** (D72). Cancelling a call leaves the work running.

Against that, the reference binding leaks 5.95 KB per server-side stream (D65) but shuts
down cleanly and propagates aborts correctly. *This entry originally said the leak was
reported upstream. It was not: see D90.*

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
the repository checked out, the dependency tree installed and network egress - before a
human has read the PR. The workflow also declared no `permissions:`, so that command
inherited whatever the repository default grants.

**Every context expansion goes through `env:` and is referenced as `"$NAME"`**, and every
workflow states its minimum `permissions:` at the top. `contents: read` is the whole
requirement here; nothing in CI writes to the repository.

The rule is absolute rather than an allowlist of contexts believed safe, and that is the
decision rather than an accident of strictness. `github.base_ref` is safe today only
because branch protection fixes the base branch - a setting somebody can change, not a
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
| `9` `WT_TOO_MANY_STREAMS` | `#openCalls` counted only *our* opens. The cap protected the peer from us and did nothing about a peer opening 10,000 - which is the case a cap is for. Now refused **before the request is read**, since the cost being bounded is the decoder, the handler and the 16 MiB the decoder will buffer. |

**Deleted, because the implementation was right and the table was fiction.** Reset codes
`2`–`8` - handler error, protocol error, unsupported codec, payload too large, handshake
incomplete, unknown event, validation failed. Every one of these is a *call* failure, and
this implementation already reports call failures as a `CALL_ERROR` frame carrying a code
**and a message**, on the stream the call already owns. A reset carries one byte. Keeping
the table would have meant implementing a strictly worse channel to satisfy a document.
The names survive as `TransportErrorCode`s, which is what they always actually were.

**The mechanism, which is the part that matters.** A promise nobody can observe failing is
not a promise, so `protocol-promises.test.ts` asserts each of these **on the wire** - the
close code a peer receives, not the `TransportError` this side raised - and a scan there
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
over `this` - retaining the Session, its Connection, the frame decoder, both queues, the
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
rejection - which ends a Node process by default, the exact opposite of the "core degrades
rather than crashing" that ADR 0005, D40 and `API.md` all promise. Local state is now
unconditional and the bus is told with `Promise.allSettled`: the peer's connection is
already gone, and a bus that cannot be told now will not be told by us failing here.

**A join rejection left a peer half-joined.** `Hub.join` mutated `#rooms` and `#peerRooms`
*before* awaiting the adapter, with no rollback and no notification. On rejection the hub
fanned broadcasts to a peer the bus had no record of, and the client was never told it had
joined - permanently. For a room gated on authorization that is traffic reaching someone
who was refused. The adapter call now happens first; local state follows it.

**The test that named this and did not test it.** `adapter-conformance.test.ts` had a case
titled *"join rejecting does not leave the peer half-joined from core's view"* asserting
only that the client was still `connected` - true whether or not the peer is half-joined.
`HostileAdapter.failNextJoin` and `failNextLeave` exist for precisely these cases and were
set by **no test in the repository**. This is D69's shape in a test written after D69.

**Why the soak could not have caught any of it, and what replaces that.** `soak.node.ts`
never disconnects a session. `soak:churn` does, and the number it reports is bytes retained
per session churned by linear fit - an absolute quantity, per D13's rule.

Its warmup is **wall clock, not a cycle count**, and that detail is the whole measurement.
`ORIGIN_QUARANTINE_MS` is 120 s: a freed origin is deliberately held for two minutes before
reuse, so a run shorter than the window measures quarantine occupancy as though it were a
leak. 12,000 cycles take 17 seconds, so no cycle count can express "past the window". The
first draft reported +402 B/session and the second +72 B, both of them quarantine and
start-up allocation rather than leak. Warming up for 130 s and then fitting over 12,000
cycles reports **−2 B/session** across 85,783 cycles, with heap flat at 9.6–9.7 MB.

| | retained per session |
|---|---|
| before the fixes | **+15,011 B** - 5.1 GB/hour at 100 sessions/s |
| after, warmup by cycle count (wrong) | +402 B, then +72 B - quarantine, not leak |
| after, warmup past the quarantine window | **−2 B** - flat |

**Reconsider when:** `soak:churn` reports a positive slope, or `ORIGIN_QUARANTINE_MS`
changes - the warmup default is tied to it and has to move with it.

### D77. The emit bound is only a bound if something stays in the bounded thing
D15 has now been dead code twice, and the second death was caused by the fix for the first.
That is the part worth recording; the fix itself is four lines.

**Death 1.** `emit` drained the queue synchronously on every push, so a burst never queued
and neither the datagram ring nor its TTL ever applied.

**Death 2.** The fix made the *datagram* flush coalesced, through an injectable scheduler -
which is why the ring and the TTL are genuinely exercised today. The **emit** flush was left
synchronous and unconditional: push, then drain the entire queue on the same turn into
`#write`, which appended each frame to an unbounded promise chain and returned. Depth
therefore returned to zero after every push, `length >= max` could never be true from a
Session, and `CloseCode.WT_PEER_TOO_SLOW` was unreachable - a documented, observable,
normative behaviour with no code path leading to it.

The backlog had not gone anywhere. It moved out of a bounded queue that disconnects and
into an unbounded chain that does not, and that chain's `.catch(() => undefined)` also
discarded every write failure on the lane advertising reliable ordered delivery. Measured:
200,000 emits of 200 bytes into a stalled writer produced two accepted writes, 102 MB of
heap growth, and a peer that was never disconnected.

**Why it was invisible.** The test was `new EmitQueue(3)`, push four items, expect a throw.
It asserted the queue - which was never wrong - and never went through a Session, which was.
Same shape as D69: the component was tested, the integration was the thing that failed.

**The fix.** One write in flight at a time, and a frame leaves the queue only when its write
*completes*, not when it is handed off. `EmitQueue.peek()` exists for exactly that
distinction. Depth now measures frames the transport has not accepted, so the bound is
reachable and reaching it disconnects the peer, as §10.2 has always said it would. A
rejected write closes the session per §5.5 instead of being swallowed. Nothing flushes
before the handshake, so frame 0 keeps its position by construction and a burst arriving
mid-handshake accumulates against the bound rather than racing it.

**The general rule, since this is the second instance:** a bound placed on a container is
enforced only while items remain in the container long enough to be counted. Any code that
removes an item at hand-off time rather than at completion time has moved the queue
somewhere else, and the somewhere else is almost never bounded. Before trusting a bound,
assert the depth is non-zero under load - `backpressure.test.ts` does exactly that, and it
is the assertion that would have caught both deaths.

**Reconsider when:** never for the completion-not-hand-off rule. The single in-flight write
could become a small window if measurement ever shows the round trip dominating throughput;
that is a performance change and needs a number first.

### D78. D1 is enforced at three points, because one of them is not enough
`{ lane: 'datagram', payload, returns }` compiled, `CallableOf` admitted the event, and a
`call()` on it opened a bidirectional stream, reached a registered handler and came back
answered. A contract that says "this message may be dropped" produced a guaranteed, ordered,
acknowledged message - with the type system agreeing at every step. That is a violation of
D1, the first decision this project made, and it was reachable through the public API.

The type hole was excess property checking against a **union**: TypeScript admits any
property present on *any* member, so `returns` on the datagram branch was accepted because
the stream branch has it. Closed with `returns?: never`, asserted in `types.test-d.ts`.

The type fix alone would have been theatre, for a reason worth stating: **a peer is not
bound by our types.** A Go implementation written from `PROTOCOL.md`, or any JavaScript
consumer one `as never` away from the contract, can open a bidirectional stream for any
event id it likes. So the runtime enforces D1 at all three points where the lane can be
subverted:

| point | what it refuses |
|---|---|
| `call()` | calling a datagram event from this side, before a stream is opened |
| `handle()` | registering a call handler for a datagram event at all |
| `#serveCall` | an inbound `CALL_REQUEST` naming a datagram event, refused with `CALL_ERROR` |

`handle()` is the one that matters most and is the least obvious. Guarding `call()` alone
leaves a responder happily answering over a bidirectional stream for an event whose contract
promises the message may be dropped - the violation completes even though this side never
initiated it.

**Reconsider when:** never. If an event needs a response it belongs on the stream lane, and
moving it there is a contract change that `negotiate()` already refuses to paper over.

### D79. Four API promises that had no code behind them
Small individually, and the same failure each time: the documented behaviour is what a
caller reads, and nothing asserted the documented behaviour.

**`handle()`'s disposer did not revoke anything.** It deleted from the server's own map
while the per-session registrations it made at accept time stayed live, so revoking a
privileged responder did nothing for any peer that was already connected. The disposer now
sweeps current peers - current, not the ones present at registration, because a session
accepted in between picked the handler up from the map.

**`join()` after teardown succeeded and was retained for ever.** `onSession(async peer => {
await lookup(); await peer.join(room) })` is the pattern the README teaches, so a client
dropping mid-lookup lands here routinely. The JOIN notify write died inside the emit path's
swallowing catch, so nothing surfaced, and the teardown that would have removed the entry
had already run. A disposed session now refuses to join, with `WT_SESSION_CLOSED`.

**The handshake deadline did not cover the handshake.** It was armed *after*
`openEmitStream()` and after writing our own handshake - so if either never settled, which
is precisely the stalled-peer case the deadline exists for, no timer was ever armed and
`connect()` hung for ever. Armed first now, and raced against both awaits. Racing `ready`
instead would be wrong: a peer whose handshake arrives before we have opened our own stream
resolves `ready` early and the race would fire on success. `handshakeDeadlineMs` also
reached `SessionOptions` from nowhere - neither Client nor Server passed it - so the only
test seam for the whole path was inert. It is now a `ClientOptions` field.

**An aborted call rejected with the platform's error, not ours.** A raw `DOMException`:
`name: 'TimeoutError'`, `code: 23`, no `remedy`. D18 removes the default call timeout on the
explicit grounds that `AbortSignal.timeout(ms)` is the documented substitute, which makes
abort the most-documented failure path this library has - and `WT_ABORTED` was in the
exported code union while being constructed nowhere, so the error-handling function printed
verbatim in `API.md` reported `'unknown'` for it. Now a `TransportError` with a remedy.

**Reconsider when:** nothing here is a trade-off, so nothing here has a trigger. It is a
list of things that were simply absent.

### D80. Where the documents were ahead of the code, and which way each was resolved
The audit's verdict was that the documentation is well ahead of the implementation. Each
gap has two possible remedies and defaulting to either is how the gap grew, so each was
decided on its own.

**Built, because a second implementation genuinely needs the behaviour:** the per-frame-type
payload cap (§5.3 described one and the decoder applied the call cap to everything, letting
a peer declare sixteen times the emit cap), the pre-handshake datagram guard (§7 says
discarded, the code decoded and delivered), and the four API promises in D79.

**Withdrawn, because the document was describing a feature nobody built and nobody has
needed:**

- **Per-event datagram TTL and `ttl: null`.** `EventDef` never grew the field and
  `DatagramQueue` takes no arguments, so the escape hatch for the one case the 150 ms
  default gets wrong was unreachable. A per-event knob is a contract-shape change; it can
  arrive with a measured case that needs it.
- **"Gate session establishment behind authentication."** This read as a feature of the
  protocol. It is not one: `Connection` exposes no headers, URL, peer address or identity,
  `ServerOptions` has no reject hook, and `accept()` writes the full event table **before**
  `onSession` fires, so the disclosure the sentence was mitigating happens before any
  application code runs. §3 now says plainly that this library authenticates nothing and
  that the mitigation belongs below it. `AGENTS.md`'s "that path is already authenticated"
  went with it.

**Corrected, because the document was simply stale:** the event id width in D-entries and
ADR 0010 still said two bytes and `u16` against a wire that has been four bytes and `u32`
since the widening; D59's worked arithmetic still carried the pre-widening numbers; and §7.3
argued for a 32-bit Origin *hash* eighty lines after the same section established that
Origin is allocated and explicitly rejected hashing - an implementer who read to the end
would have built the collision the first half exists to eliminate.

A normative reference to an unrelated private project of the author's was also removed from
D29. It was a scope leak the earlier cleanup missed.

**The rule this leaves behind:** every numeric constant in `PROTOCOL.md` is asserted against
`protocol.ts` by `scripts/check-docs.ts`, which is why the widening broke the *documents*
and not the *gate*. Prose has no such gate, which is why the stale prose survived three
rounds of review. Where a document states behaviour, prefer a test whose name is the
statement - see D75 and D78.

### D81. The thirteen deferred items, none of which was deferred
Every CAN WAIT finding was acted on. Two of them turned out not to be cosmetic at all, and
that is the entry's point: "can wait" was a judgement made from the outside, and two of
those judgements were wrong.

**Gates that could not fail.**

- `test:node` ran through `--if-present` and a glob that exits 0 on zero matches - two
  independent ways for the only required check that exercises the native transport to be
  green while testing nothing. `scripts/run-node-tests.sh` asserts the reported test count
  instead. Verified both ways: 7 tests on the real glob, exit 1 on a glob that matches
  nothing.
- The D14 import boundary was a Biome rule listing three package specifiers, so
  `import … from './transport/fails.node.ts'` inside a plain `*.test.ts` passed `biome ci`
  cleanly - measured, 0 diagnostics. That is the *more likely* of the two mistakes: nobody
  reaches for the raw package name when the wrapper is next door. Replaced by
  `scripts/check-boundaries.ts`, which checks the property rather than a list of names.
- `check-node.sh` compared majors while its own error text named 22.18, so every Node
  22.0–22.17 passed and then died with the exact error the script exists to convert.
  `scripts/check-node.test.sh` runs it against stub versions, because the versions being
  tested cannot run a TypeScript test.
- `pull_request:` had no `types:`, so `edited` fired nothing: a PR retitled after the title
  check went green kept the green check, and the squash subject comes from the title.

**Assertions that could not fail.** The e2e cursor check matched `translate(\d+px, \d+px)`,
which all twelve positions satisfy including the first - a sign error freezing the cursor
after one datagram passed it. It now asserts the exact distance travelled. The quarantine
invariant compared against literals rather than the constants it is an invariant *between*.
`call.test.ts` had two tests on one code path; `call()` now refuses a `returns`-less event
by name, so the two faults have distinct messages matching their distinct remedies.

**The one that was not cosmetic.** `Hub`'s remote-delivery branch had never executed a line,
and writing the first test for it found a real defect: **the Hub deduped against the
`Server`'s `nodeId` while the envelope carries the *adapter*'s.** Where those differ - which
is any deployment configuring them separately - a node delivered every local broadcast
twice, once locally and once back off the bus. `nodeId` is now part of the `Adapter`
interface and the dedup reads it from there, so the two cannot diverge.

Writing that test also required making the adapters able to model more than one node at all:
both `MemoryAdapter` and `HostileAdapter` were per-instance islands, which is *why* the path
was never tested. They now accept a shared `memoryBus()`.

**The documentation gate was blind in both directions.** Blocks were concatenated per
document, and TypeScript hoists imports - so a block could use a name imported by a *later*
block. That is how the README's flagship "the whole surface, in one file" snippet called
`defineContract` without importing it. Fixing the snippet then failed as a duplicate
identifier, which is the same blindness from the other side. Blocks now compile against
their prefix with imports deduped per binding, and a block that claims to be a whole file is
tagged ```ts standalone and must compile with nothing before it. Verified by removing the
import again: the gate fails.

**Documents contradicting their own tooling.** D29 told authors to write `BREAKING CHANGE:`
footers in the PR body, which `body-empty`, `footer-empty` and
`squash_merge_commit_message=BLANK` all discard - and the `pr-title` job pipes only the
title, so such a footer was never linted *and* never landed. The same entry offered
`fix(react):` as an example scope, which the gate it was describing rejects.

**Nothing was deferred, so nothing carries a trigger.** If an item here needs revisiting it
will be because a gate started failing, which is the outcome all of them were rebuilt for.

### D82. Normative prose has a gate now, and it is deliberately shallow
Numeric constants are asserted against `protocol.ts`. Code blocks are compiled. Sentences
saying what an implementation MUST do were checked by nobody - which is how four promises
lived in three documents and no code, and how ADR 0010 went on claiming a `u16` event id
against a wire that had been `u32` for weeks. Every other kind of drift in this project has
been caught by a gate; this kind kept getting through review instead.

**The rule.** Every normative statement in `PROTOCOL.md` and `API.md` carries an identifier
naming a test file, and that file must mention the identifier back:

```
A peer MUST send its handshake without waiting for the other side's.
<!-- norm: handshake-sent-without-waiting -> packages/core/src/protocol-promises.test.ts -->
```

The link is checked from both ends, so a marker cannot name an unrelated file and a test
cannot claim coverage the document does not acknowledge. Markers are HTML comments:
invisible when rendered, trivial to grep, and they survive copy-paste into a Go
implementation's notes.

**What it does not do, on purpose.** It does not verify the test is any good, or that it
runs, or that it asserts the statement rather than something adjacent. Building that would
mean a proof system, and this had to be finished in an afternoon. What it does is make an
unimplemented promise impossible to write down *silently* - writing `MUST` now costs either
a test or an explicit, counted admission that there is none.

**The admission has a ratchet.** `-> UNPROVEN: <reason>` records an honest gap, and the
count is printed on every run against a ceiling of 8 that may only go down. Same idiom as
the `ignore` block ceiling in `check-docs.ts`, for the same reason: an exemption without a
ratchet becomes permanent on the first busy afternoon. Three statements are unproven today,
and writing them down found the third - no test sends more than one `CALL_RESPONSE`, so D7's
multi-frame shape is reserved and unexercised. That was going to be discovered by whoever
implemented token streaming against it.

**Coverage rules that make it usable rather than resented.** One marker covers a run of
consecutive normative lines within 40 lines, so a table of MUSTs takes one marker and not
twelve. `API.md` states guarantees as bold lead-ins rather than RFC-2119 keywords, so a bold
opener containing "never" or "always" counts too - "**The lane lives in the contract, never
at the call site.**" is exactly as binding as a MUST and would otherwise have slipped past.

**Verified by breaking it**, three ways: a new `MUST` with no marker, a marker naming a file
that never mentions it, and a duplicated id so two statements appear to be one. Each fails
the gate. `scripts/check-norms.test.ts` also asserts the real documents parse into more than
twenty statements and twenty markers, so a change to the marker syntax cannot quietly turn
the whole thing into a no-op that reports nothing and exits 0.

**Reconsider when:** the unproven ceiling cannot be lowered because a statement is genuinely
untestable at this layer. That is an argument for deleting the statement, not for raising the
ceiling.

### D83. The first publish is `0.0.1` to hold the name; `0.1.0` is the first release
Stage 1 was defined as the first stable publish with semver in force. Amended twice.

**`0.0.1` is a name claim, not a release.** npm has no reservation mechanism - verified:
`npm owner ls` on an unpublished name returns 404 and there is no `reserve` or `claim`
subcommand - so the only way to hold `transport-io` is to publish something under it. That
something is `0.0.1`, and it carries no promise beyond existing. **`0.1.0` is the first
release**, and the Stage 1 rules apply from *it*, not from the name claim.

Three reasons, none of them a matter of taste.

**`call()` ships with a documented defect outside our control.** The headline feature leaks
~5.95 KB of server memory per stream, upstream in the QUIC binding (D65, D67, D73). A
`1.0.0` whose flagship capability carries a known leak is a claim the code does not support.

**Thirty-one before-release defects were found in one sweep**, hours before the first
publish. Among them: four normative promises with no implementation, a datagram event that
could be called and answered, a session leaked on every disconnect, and an emit bound that
could not be reached. That is not the shape of a codebase whose API is settled - it is the
shape of one that has not been read hard enough yet, and the sweep is evidence of both.

**`0.x` costs nothing and `1.0.0` promises what there is no evidence for.** Nobody is
depending on this yet, so the option to break something cheaply is free; the promise of
stability is not.

**What still applies from the first release.** No breaking change without a version bump and
a changelog entry. The difference under `0.x` is that a **minor** bump is allowed to break,
and the README says so rather than leaving a reader to infer it from the leading zero.

**Reconsider when:** a sweep of the same depth as the one that produced D74–D82 finds
nothing of that severity, and the upstream stream leak is fixed or routed around. Both are
observable, neither is a date.

### D84. `close()` is idempotent in both halves, not just the one that was
Found by running the full lane soak after D76 rather than by reading the diff.

`Session.close()` calls `dispose()` and then `conn.close()`. `dispose()` was made idempotent
in D76; `conn.close()` was not. A client disconnecting while the server tears the same
session down is ordinary and, under load, constant - so the transport was told to close the
same session twice, over and over. quiche logs `WebTransportHttp3 close sent twice` and
refuses the extra call.

The number is the point: **865,464 of those lines in one 60-minute soak**, enough to bury
the soak's own sampled output entirely. Nothing failed, no test went red, and the behaviour
was a protocol-level complaint from the transport that this library generated and then
ignored. It was visible only because the soak was run end to end after the fix that caused
it, which is the argument for running the soak at all.

`close()` now returns early when already disposed, and `lifecycle.test.ts` asserts the
transport is told exactly once however many times `close()` is called.

**Reconsider when:** never. An idempotent teardown that is idempotent in only one of its two
steps is not idempotent.

### D85. The soak certified the absence of measurement
Found by running a deliberately short soak to check something unrelated, and reading the
output instead of the exit code.

```
samples (after 10min warmup): 0
slope (linear fit)   +0.00 MB/h   bound < 4     PASS
peak RSS             -Infinity MB  bound < 600   PASS
SOAK PASSED
```

A two-minute run never reaches the end of its own ten-minute warmup, so it collects no
samples. With none: the least-squares denominator is zero and the function returns a slope
of **0**; `Math.max()` of an empty array is **-Infinity**; and both are comfortably inside
their bounds. The soak that certifies D13 passed while having measured nothing at all, and
exited 0 while doing it.

This is the D13 defect one layer further down, and the third variant of it in this project:

| | what was certified |
|---|---|
| original D13 | growth as a percentage of a baseline nobody fixed - passed against the leak it was written to catch |
| D76's first draft | quarantine occupancy, reported as leak, because the run was shorter than the quarantine window |
| here | **nothing**, reported as a pass, because the run was shorter than the warmup |

Each time the number looked fine. `+402 B` and `PASS` and `-Infinity` are all things a person
skims past.

**The rule this settles.** A threshold is meaningless without a stated minimum number of
observations, and that minimum is part of the criterion rather than an implementation
detail. Both soaks now require at least three samples - the fewest a least-squares line
means anything over - and say so in their output when they do not have them. The churn soak
already had the guard, which is why it was the one that produced trustworthy numbers.

**Reconsider when:** never. If a run is too short to sample, the correct result is a failure
that names the reason, which is what it now prints.

### D86. Two packaging defects only a fresh clone could find
Both were invisible in the working repository, because a working repository has already
built and already installed. This is the whole argument for the clone-install-run check.

**`npm run e2e` did not work from a clean clone.** The example imports the library through
its `exports` map, which points into `dist`, which does not exist until `tsc --build` runs.
Every local run passed because `dist` was already there from some earlier command. A
contributor's first `npm run e2e` failed with `Could not resolve: "transport-io/browser-transport"`.
`e2e:server` now builds the library first.

**The install line was wrong, and it was wrong in the commit that fixed the install line.**
The README said `npm install github:v0id-user/transport-io` (the repository's address at the time). That resolves the repository
root, whose package is `transport-io-monorepo` and is `private`, so what a consumer actually
installs is the monorepo root and `import … from 'transport-io'` fails. Verified by running
it into a scratch directory: `node_modules/transport-io-monorepo`, no `transport-io`.

The sequence is the point. The original defect was an install line naming an unpublished npm
package. It was replaced with a git install that does not work either - corrected in the
same afternoon, by the same person, in a document about not fabricating things. An
instruction that has not been executed is a guess about how a tool behaves, and monorepo git
installs are exactly where that guess goes wrong. Until the first publish the documents say
clone and build, which is the only sequence that has been run end to end.

**Reconsider when:** the package is published. At that point both READMEs change to
`npm install transport-io` in the same commit as the publish, and not before - an install
line pointing at a name nobody owns is how a reader installs a stranger's package on this
project's authority.

### D87. Green on empty is a class, not a bug
Every gate in this repository was fed an input set with nothing in it. Six passed.

An aggregate over an empty collection, compared against a bound, **passes**. Zero violations
is zero. `Math.max()` of nothing is `-Infinity`. A least-squares denominator of zero returns
a slope of 0. Every one of those is inside every threshold, so the gate reports success
having examined nothing - and finding nothing is far more often a broken glob than a clean
repository.

| gate | fed nothing, before | after |
|---|---|---|
| `check-norms` | **passed** - 0 statements, 0 markers | fails: floors of 20 and 15 |
| `check-workflows` | **passed** - glob matched no files | fails: floor of 1 |
| `check-boundaries` | **passed** - glob matched no source | fails: floor of 40 |
| `check-docs`, snippets | **passed** - 0 blocks compiled cleanly | fails: floor of 15 |
| `check-docs`, constants | half - an empty parse agrees with an empty enum | fails: floor of 3 rows per table |
| `knip` | **passed** - no entry files, `{"issues":[]}` | fails via `check-gate-inputs` |
| `attw` | **passed** - empty `dist` | fails via `check-gate-inputs` |
| `publint` | already failed | unchanged |
| `bun test` | already failed on zero matches | unchanged |
| `test:node` | already fixed in D81 | unchanged |
| `soak:lanes` | already fixed in D85 | unchanged |
| `soak:churn` | already guarded | unchanged |
| `check-node.sh` | passes, **correctly** - it checks one value, not an aggregate | unchanged |

`knip` and `attw` are third-party and cannot be taught this from the inside; "no issues" is a
truthful answer to "look at nothing". The floor has to come from the caller, which is
`scripts/check-gate-inputs.ts`: every knip workspace must exist and hold source, and every
target named by the package's `exports` map must be present in the packed tarball.

**One thing this exercise cost, worth recording.** The first draft of the knip floor
translated its glob patterns by hand and reported three false negatives against patterns that
do match. A second, subtly different glob matcher in the repository is a liability, so it was
replaced with a floor on files under each workspace root - which catches the failure that
actually happens (a config pointing at a renamed directory) without pretending to
reimplement anything.

**The rule.** A gate must distinguish "found nothing wrong" from "found nothing". Any check
that reduces a collection to a verdict states a minimum size, and that minimum is part of the
check rather than a detail of it.

**Reconsider when:** a floor starts failing because the repository legitimately shrank. Lower
it deliberately, in a commit that says why - the same ratchet as every other ceiling here.

### D88. The three unproven norms are zero
D82 shipped with three `UNPROVEN` markers against a ceiling of eight. A ratchet is the right
mechanism and an unproven normative statement is still documentation ahead of implementation
with a number attached, so each was either proved or the promise was corrected. All three
turned out to be provable, two of them only after the implementation grew what the statement
already claimed.

**`receiver-accepts-multi-frame-response` - proved, and the document corrected too.** The
receiver genuinely does tolerate a sequence; it was untestable only because no sender in this
library produces one. Writing the sequence by hand from a raw stream proves the tolerance.
But §6 read as though multi-frame responses happen, and a Go implementer would have built a
receive loop for something that never arrives. The section now says **reserved, not
implemented** in a block that cannot be skimmed past, while still requiring tolerance -
because that tolerance is what keeps token streaming from being a protocol break later.

**`host-ordinal-exhaustion-refuses` - proved, via a seam.** Reaching the branch meant
4,194,304 allocations. `OriginAllocator` now takes a counter-space parameter, used by the
test and by nothing else, and the exhaustion path is exercised at size 8. An unreachable
branch in an allocator is exactly the code that is wrong the first time it runs, and this one
also had to prove the right *remedy*: the error says concurrency limit, not clock, so an
operator does not restart the host expecting it to help.

**`session-streams-not-reused` - the implementation did not do it.** Nothing stopped `call()`
opening a stream on a closed session. The transport may well accept the open, in which case
the call hangs for ever rather than failing. `call()` now refuses with `WT_SESSION_CLOSED`.

Three honest "reserved" lines would have been acceptable. Three proved statements and one
corrected section are better, and the third was a real defect that the marker had recorded
as merely untested.

**Reconsider when:** the ceiling of 8 is still the mechanism. It is at zero now, and a future
`UNPROVEN` should be argued for rather than budgeted.

### D89. The guard against a silent pass caused a silent-looking failure
D81 wrapped `node --test` so the integration job could not report success while running
nothing. The wrapper parses the summary line for a test count. It matched `# tests 7`.

The GitHub runner's reporter prints `ℹ tests 7`.

So the first CI run after that change went red on a job where all seven tests passed -
`pass 6, fail 0, skipped 1` - because the guard could not read the summary and treated an
unparseable count as zero. Locally it was invisible: a non-TTY local run emits the `#` form,
which is the one the guard knew.

Two things to keep from it. **A guard that cannot parse its input must say so** rather than
defaulting to the failure it was written to detect - the message now distinguishes "matched
no tests" from "could not read the summary", because those need different fixes. And
**anything that parses another tool's human-readable output is environment-dependent by
construction**: the count and the pass total are now both extracted, matched on the word
rather than the prefix, so a third reporter shape fails loudly instead of silently
re-reading as zero.

The wrapper still exits 1 on an empty glob. Verified in both directions.

**Reconsider when:** `node --test` grows a machine-readable summary that does not depend on
the reporter. Until then this parses prose, and parsing prose is what this was.

### D90. The limitations get their own page, and the leak was never reported upstream
Two things, one of which is a correction.

**The correction.** Three documents said the upstream stream leak was "reported upstream".
It was not. An issue describing it was opened against the binding and closed 75 minutes
later by the same account, with zero comments, so no maintainer ever saw it. The claim was
load-bearing in exactly the wrong way: a reader deciding whether to depend on this would
have read "reported" as "someone is looking at it" and planned around a fix that nobody is
working on. `README.md`, `SECURITY.md` and D73 now say it is not tracked, and say that the
whole of the measurement's provenance is a bench script in this repository.

**The placement.** The limitations lived above the install instructions, which D67 and D73
put there deliberately. The reasoning was sound and the result was not: the first thing a
reader saw was seven headings explaining why not to use this, before a single line of what
it does.

Nothing was softened and nothing was cut. Every word moved to `KNOWN-ISSUES.md`, which now
also separates the two kinds of entry that were previously mixed: the design positions that
will not change, and the one measured defect. The count is deliberately not stated, because
a count in a document is a number that goes stale silently. The README links it as "read this before you
start", and `packages/core/README.md`, `CONTRIBUTING.md` and `SECURITY.md` all point at it,
because a page nobody links to is where a limitation goes to be forgotten - the same failure
mode as `OPEN-QUESTIONS.md`.

The rule that survives from D67 is the one that mattered: the leak ships documented, with
the measured number and the transport it applies to. Where the document sits is a separate
question from whether it tells the truth.

**Reconsider when:** anything on that page stops being reachable in one click from the
README, or an entry is added that is neither a position nor a measurement. Both are visible
in review rather than by tooling, which is a weaker guarantee than this repository usually
accepts, and is recorded as such.

### D91. The consumer floor gate was wrong in both directions, and nobody was watching CI
The gate that checks the published `.d.ts` against TypeScript 5.0 has now failed twice, in
opposite directions, and the second failure was introduced by the commit that fixed the
first.

**Direction one: it could not fail.** The command was
`tsc --skipLibCheck packages/core/dist/index.d.ts`. That flag skips checking every
declaration file *including the one named on the command line*, so only parse-level
diagnostics ever surfaced. The gate had been green for its whole life without ever checking
a type.

**Direction two: it failed on nothing that mattered.** Removing the flag left the command
running in the repository root, where `npm ci` has installed the full dev tree. With library
checking on, TypeScript 5.0 type checked `bun-types` and `@types/node` against its own
`lib.dom.d.ts` and produced about forty errors, none of them from this package. Main went
red and stayed red for three commits.

The fix is `scripts/check-ts-floor.sh`, and its shape is the point: **a consumer gate must
run where a consumer stands.** The packed tarball, a temporary directory, `types: []` so no
ambient package is auto-included, an explicit `lib`, and `skipLibCheck` off so our
declarations and our declared dependencies are checked and nothing else is. Both consumer
resolution modes, because D56 records that `bundler` and `node16` disagree about
extensionless imports. Plus a negative probe: a wrong event name must still be rejected at
5.0, so the gate fails loudly if the checking silently stops happening.

**The process failure is the more expensive one.** Three commits were pushed to main after
the breakage, two of them by an agent that had run every gate locally and never once looked
at the run it had just triggered. Local green is not CI green, and the difference between
them is exactly the class of defect that this gate was in: an environment the local run does
not have. **Pushing is not finishing.** Check the run.

**Reconsider when:** the floor moves off 5.0, or `attw` grows the ability to check a
tarball's declarations under a named compiler version, which would make most of this script
redundant.

### D92. Lanes are named for the guarantee: `reliable` and `unreliable`
`lane: 'stream'` becomes `lane: 'reliable'`, and `lane: 'datagram'` becomes
`lane: 'unreliable'`.

The trigger was a collision. `stream()` is a streaming response, `lane: 'stream'` is the
reliable lane, and `{ lane: 'stream', yields: ... }` would have put both meanings of the word
in one line of every example forever. But the collision is the symptom. `stream` and
`datagram` name QUIC streams and UDP datagrams, which are mechanisms, and the thesis of this
library is that mechanisms are hidden and guarantees are exposed. The lane was the one place
that said the opposite, and it said it in the single most-read line of every contract.

**This touches the wire.** `WireEvent` is `[name, id, lane]` and the lane travels as its
literal string; `isWireEvent` validates it. A 0.1.0 peer meeting a 0.2.0 peer fails at
`parseHandshake` with `WT_PROTOCOL_ERROR` and the message `malformed handshake: 'events' is
not an array of [name, id, lane] triples`. That is acceptable only because the protocol is
version 0 with an exact-match handshake and there is no deployed peer to break. It would not
be acceptable after the first stable release, which is part of why the rename happened now.

**No error code changed.** `WT_TOO_MANY_STREAMS` and `WT_DATAGRAM_TOO_LARGE` are about QUIC
stream count and path MTU. They name the mechanism because they are about the mechanism,
which is the same rule pointing the other way.

The mechanism stays visible in the documents rather than being scrubbed: `PROTOCOL.md` §3
and §7 both state that the reliable lane is carried on QUIC streams and the unreliable lane
on QUIC datagrams, and `README.md`, `API.md` and `packages/core/README.md` each say it once,
so a reader searching either word still lands somewhere useful.

Ledger entries before this one use the old spelling. They are records of what was decided at
the time and are not rewritten.

**Reconsider when:** never, absent a third lane. If one arrives, it is named for what it
promises.

### D93. `stream()` ships, and the backpressure it claimed had to be built
An async iterable on the client, an async generator on the server. The shape and its three
reasons are ADR 0012; this entry records what the implementation changed about the design.

**The design claim was false and the measurement caught it.** `stream()` was justified partly
on the grounds that flow control falls out of the language: a generator does not resume until
its frame is accepted, so nothing accumulates. Measured against the reference binding, a
producer ran **136,523 frames and roughly 53 MB** ahead of a consumer that had taken 40, and
the gap grew linearly with the run at every element size tried. `writer.ready` resolves
unconditionally there, so awaiting it applies no backpressure at all.

That is D77 exactly: a bound is only a bound if something stays in the bounded thing, and
nothing was staying anywhere. Shipping it as designed would have documented a guarantee the
transport does not provide, which is the same defect class as the four unimplemented promises
in D69, arriving through a different door.

So the accounting is ours. `CALL_CREDIT`, PROTOCOL.md §6.6: 32 frames of initial credit,
spent one per response frame, refilled in batches of 16 by the consumer as it takes elements.
The same measurement with the window is **33 frames, flat**, unchanged when the run doubles.
The number in the ADR is the measured one, not the target.

**Two things the implementation found that no amount of design would have.**

`writer.abort()` cannot interrupt a producer parked inside `writer.write()`. Per the streams
contract the abort queues behind the write already in flight, so a generator blocked writing
to a consumer that has stopped reading stays blocked for ever and its `finally` never runs.
The write is now raced against the abort signal. Found by the cancellation test hanging, not
by reading the code.

A streaming initiator cannot half-close after its request, because its send side carries the
credit. FIN from one therefore means "no more credit is coming", and the responder treats it
as cancellation rather than stalling once its window is spent. Without that rule a
`returns`-shaped peer calling a `yields` event holds a generator and a stream slot open until
the session dies.

**Reconsider when:** a transport with honest flow control becomes the default. The window
stays regardless - a responder is entitled to stop at zero and cannot know which transport it
is talking to - but its size becomes a tuning question rather than the only defence.

### D94. A decision claimed a test pinned something the test did not assert
D57 established the two-line contract pattern and recorded the evidence: `emit` hover is 126
characters with the interface, 303 without. It ended with "the 126-character form is pinned
in the type-level test."

It was not. `types.test-d.ts` uses the pattern, and asserts nothing about hover at all. The
number came from a person looking at an editor once, and from there into `README.md`,
`API.md`, `AGENTS.md` and `CLAUDE.md`, four documents quoting a measurement nothing checked.

This is D69's defect in a decision rather than in a document, and it is worse in one respect:
D69's four promises were at least discoverable by looking for the code. A decision that says
a test exists is trusted precisely because this project's rule is that claims carry tests.

**`scripts/check-hover.ts` now measures it.** TypeScript 7.0 has no compiler API until 7.1,
but `tsc --lsp --stdio` speaks LSP and `textDocument/hover` returns the string an editor
renders. The gate drives the language server, measures both forms, and fails on an absolute
ceiling and on the ratio between them. Verified in both directions: a lowered ceiling fails
it, and making both forms inline fails it.

**The re-measurement found the numbers wrong.** For the README's contract they are **107**
and **353**, not 126 and 303, and the 353 is after TypeScript's own elision hides part of the
validator's internals. All four documents are corrected.

The more useful half of the finding is why an exact number was never reproducible: **hover
width is a property of the contract, not of the library.** A different contract gives
different numbers, and 126 was quoted for years with no way for a reader to reproduce it. The
gate pins a specific probe contract and says so, and the documents now name the contract the
numbers belong to.

**Reconsider when:** TypeScript 7.1 lands the compiler API, which would make this a few lines
instead of an LSP client. The gate should shrink then, not disappear.

### D95. Four corrections to `stream()`, all from measuring things that were assumed
Follow-up to D93, and every entry here came from a check that was asked for rather than one
that was volunteered.

**The ADR carried a reason the measurement had already falsified.** ADR 0012's second
justification for the async iterable was "backpressure falls out of the language". D93
recorded that the measurement disproved it, and the ADR kept saying it anyway. The reason is
now `next()` is the credit signal, which is a stronger argument because it rests on the
measurement instead of contradicting it, and the falsified claim is struck in place rather
than quietly rewritten. A record that silently replaces a disproved claim teaches nothing;
the next person builds on it again.

**32 and 16 were inputs presented as though they were results.** "33 frames, flat" is a
measurement; the 32 that produced it was a guess. Swept: the bound is always window + 1, a
window of 4 costs 29% throughput, 8 through 32 are indistinguishable, and 128 buys 28% for
four times the memory ceiling, which at 64 KiB elements and 256 streams is 2 GiB against 512
MiB. 32 is the top of the flat region. Every number is localhost, which understates the case
for a larger window, and that caveat is the revisit trigger. The sweep also found that a
refill batch larger than the window deadlocks both sides, which is now normative.

**A parked producer outlived its session.** With no timeout on the credit wait, a consumer
that stops taking elements without breaking the loop leaves the responder waiting for ever -
correct, and the point of backpressure. But `dispose()` cleared handlers and never aborted
the responses in flight, so when the peer disappeared entirely the generator stayed parked,
holding one of 256 stream slots and whatever the handler had open, with nothing left that
could wake it. Every in-flight response is now aborted when the session ends.

**The bound was gated over the wrong transport.** The credit test ran over the loopback, and
the loopback applies backpressure of its own: widen the window to ten million and that test
still passes. It was green whether or not the mechanism existed, which is the D87 failure
shape in a test rather than a tool. The bound is now asserted in `stream.node.test.ts` over
real QUIC, verified to go red when the window is widened, and the loopback test is scoped to
what it can honestly show.

A fifth thing, found on the way: the ceilings were written as `<= STREAM_INITIAL_CREDIT + 1`,
so widening the constant widened the assertion. That is D13's rule broken again in a new
file - a threshold must be an absolute quantity, never a proportion of the thing under test.
They are absolute now, with a companion assertion on the constant so a deliberate change
fails loudly in one place.

**Reconsider when:** the window is measured over a link with real round-trip time.

### D96. Two sweeps: assertions that cannot fail, and everything `dispose()` owns
Both were asked for after `stream()` landed, and both found things.

**Sweep one: a bound that references the constant under test is not an assertion.** Nine test
files import a protocol constant. Six use it to build an input and assert something
independent, which is the correct shape. Three did not:

- `stream.test.ts` and `stream.node.test.ts` compared against `STREAM_INITIAL_CREDIT + 1`,
  so widening the window to ten million widened the assertion with it. Already fixed in D95.
- `datagram-lane.test.ts` derives the burst from `DATAGRAM_QUEUE_MAX` *and* expects
  `DATAGRAM_QUEUE_MAX`, so the drop-oldest behaviour is proved for any cap and the cap itself
  for none.
- `framer.test.ts` asserted the declared length equals `STREAM_HEADER_BYTES + 5`, which the
  encoder computes from the same constant. It asserts the encoder agrees with itself, which
  is true for any header size including a wrong one.

Fixed the same way in each: one absolute assertion pinning the constant next to the
behavioural ones, so a deliberate change fails in one obvious place and an accidental one
cannot pass. `protocol-layers.test.ts` compares two constants to each other -
`ORIGIN_QUARANTINE_MS > SEQUENCE_STATE_RETENTION_MS` - and that is not this pattern: the
relationship is the whole content of the claim.

**Sweep two: `dispose()` was incomplete for the third time.** It had already been caught
leaving an interval alive and a parked producer holding a stream slot. The enumeration found
two more:

- **Queues and per-peer state were never released.** 256 emit frames, 64 datagrams, the
  duplicate-suppression map for every origin heard from and the sequence counter for every
  origin sent to, all retained by a session that had ended. Bounded, so not a leak that
  grows, but retained references to payloads nobody will ever receive.
- **A disposed session still accepted emits.** `sendEncodedFrame` queued into a queue that
  would never drain and told the caller nothing, so the hub fanning a broadcast at a peer
  that died mid-broadcast quietly grew the dead peer's queue. It drops now, rather than
  throwing, because one dead peer is not an error for the other twenty in the room.

The list is now a test: `disposal releases everything a session owns`, naming the interval,
the handlers of all three kinds, the writer, both queues, the peer state, the work in flight
and the disposed flag. Three incomplete teardowns in a row is not carelessness repeated, it
is the absence of an enumeration. Anything a session starts owning goes in that test.

**Reconsider when:** a session acquires something new. The test is the checklist, and it
fails until the new thing is in it.

### D97. The constants gate was an allowlist, so it could not report what it did not know
`16 frames high-water` sat in PROTOCOL.md §9 for the life of the project. It matched no
constant in `protocol.ts`, appeared in a normative table a second implementer would build
against, and survived a gate whose entire purpose is comparing documented constants to real
ones.

The gate asked one question: for each constant I know about, is it documented correctly? It
never asked the reverse: for each number in the document, is it real? Its coverage was
therefore the set someone had remembered to add a regex for, and a number nobody had thought
about was invisible by construction. That is D87's green-on-empty in a new place - not a
check that examines nothing, but one whose scope is defined by what it already knows.

The sweep now runs document-first: every number carrying a unit in a PROTOCOL.md table must
be claimed by an expectation pinned to a named constant, and every expectation must match
exactly one row. Both directions matter. Without the first, a new normative number appears
unchecked; without the second, renaming a row makes the check quietly stop checking.

**Membership was not enough, and the first draft proved it on the spot.** Checking that each
number exists *somewhere* in `protocol.ts` passed `16 frames` immediately, because 16 is
`STREAM_CREDIT_REFILL` and the row is about something else. A gate that accepts the right
number for the wrong reason is worth very little. Identity is the check.

What it still cannot do is verify a number that is correct for its own row but wrong as
design. Nothing textual can. The stronger version would put implementation identifiers into
a document written to be implemented from scratch in another language, which is the wrong
trade.

**Reconsider when:** a normative constant appears somewhere other than a table, which is the
one shape this sweep is blind to by design.

### D98. Seven gates were allowlists, and an allowlist cannot report what it omits
D97 fixed one gate that only checked constants somebody had remembered to list. The obvious
next question was whether any other gate had the same shape, and seven did: each iterated a
known set asking "is each of these correct" rather than sweeping the subject asking "is
anything unaccounted for". The difference is invisible while the list happens to be complete
and total while it is not.

Fixed by inverting the direction so the subject drives coverage:

- **`protect-branch.sh`** carried eight context strings. Adding the `site` workflow made it
  eight of ten and nothing noticed. Contexts are now derived from the workflow files by
  `scripts/required-checks.ts`, which also excludes jobs that cannot report on a pull request
  and prints why, because a job silently dropped from protection is the failure this exists
  to prevent.
- **`commitlint.config.ts`** listed scopes while `CLAUDE.md` claimed they were "validated
  against the workspace package list". They were not, and the gap surfaced the first time a
  workspace was added. Derived from `workspaces` now, plus four meta scopes that are
  genuinely not packages.
- **`check-install-line.ts`** scanned two documents. `AGENTS.md` carried a third install line,
  missed twice over: wrong file, and an untagged fence the pattern would not have matched
  either. It now discovers every tracked markdown file and dedupes by command.
- **`check-norms.ts`** and **`check-docs.ts`** each scanned a fixed list of documents. Both
  now assert the inverse as well: any tracked document containing normative language, or a
  TypeScript block, must be either in scope or exempt with a stated reason.
- **`check-ts-floor.sh`** exercised five of forty-eight exports. Measured, importing one
  symbol pulls thirteen of twenty-four declaration files into the program, so eleven were
  never checked at the floor version. Coverage is now driven by the tarball: every shipped
  declaration must be reachable from a public entry point or listed as unreachable. That
  immediately found the probe missing an entire entry point, and five declarations that ship
  while no consumer can import them.
- **`check-hover.ts`** measured `emit` while D57's claim is about the pattern. It measures
  `emit`, `call` and `stream` now, with a ceiling each, because one ceiling derived from
  `emit` is either wrong for `call` or so loose that `emit` could triple unnoticed.

**Clean, and worth copying:** `check-boundaries` walks the tree, `check-workflows` scans the
directory, `run-node-tests.sh` globs and counts, `docs-freshness` reads the diff. All ask
what is there.

**Reconsider when:** a new gate is written. The question to ask of it is not "does it check
the right things" but "what would it fail to notice", and if the answer is "anything nobody
added to a list", it is this defect again.

### D99. The iterator helpers are ours, sequentially, and the proposal's concurrency is refused
`stream()` gains `take`, `forEach`, `toArray` and `cancel`. The names and signatures follow
the TC39 async iterator helpers proposal, and `collect()` is renamed to `toArray()` to match.
That resemblance is where the alignment stops, and this entry exists so nobody reads more
into it.

The proposal was read rather than recalled. From its README:

> **This proposal is in the process of being revised.** The core set of helpers and their
> high-level API is unlikely to change, but the underlying specification mechanism will
> likely be radically revised.

The revision is about **concurrency**. `map`, `filter`, `take`, `drop` and `flatMap` are being
redesigned so several `next()` calls can be in flight at once, and the README says the exact
details "are not yet decided".

**We implement these sequentially and will not adopt the concurrent semantics if they land.**
A helper that pulls ahead of its consumer defeats the credit window: the window bounds the
producer at 32 frames beyond what the consumer has *taken*, and a concurrent `take` or `map`
takes eagerly. The bound would still hold numerically while measuring something the
application no longer controls.

So the plan is not "delete ours when the native version arrives". Swapping to a concurrent
implementation would be a behaviour change wearing the clothes of a cleanup, and it will look
like an obvious tidy-up to somebody in six months. It is not.

`forEach` is unaffected by the revision - it consumes rather than producing an iterator - and
it awaits its callback before pulling the next element, which is what makes it safe here and
what `onstream(cb)` could never have offered.

`cancel()` is not in the proposal at all. It is ours, for stopping from outside the loop,
where `break` cannot reach.

`map` and `filter` are deliberately not shipped. On a token stream the work belongs in the
loop body, they are the two most exposed to the concurrency revision, and each is another
chain link that has to propagate cancellation back to the source.

**Reconsider when:** the proposal reaches Stage 3 with settled semantics. Even then, adoption
is a decision about backpressure rather than about standards compliance.

### D100. `Register` holds the map, not the contract
Module augmentation removes the type parameter from `new Client({ contract })`. The obvious
shape is to register the contract itself, which is what TanStack Router and Hono appear to do
and what this change was originally specified as. Measured, it is wrong.

Registering the contract means resolving the map through a conditional type:

```ts
type Registered = Register extends { contract: infer C } ? MapOf<C> : never
```

That is an alias instantiation, and TypeScript expands alias instantiations while preserving
interface names. Printed:

```
Client<MapOf<{ readonly chat: { readonly lane: "reliable"; readonly payload:
StandardSchemaV1<unknown, { from: string; body: string; }>; }; readonly save: { ... } }>>
```

Registering the map instead:

```
Client<AppMap>
```

This is D57 arriving from a new direction, and the failure mode is the one D57 exists to
prevent: hover regresses to the width of the inline form, 377 characters against 107, with
the validator's internals back in it.

So `Register` holds `map: AppMap`, the two-line contract pattern stays, and what the change
removes is the type argument at every construction site rather than the interface line. That
is the smaller win, and it is the one available.

The unregistered case resolves to a sentinel whose only key is the instruction, so the first
`emit` fails with `Argument of type '"chat"' is not assignable to parameter of type '"no
contract registered: declare module ..."'`. The sentinel must be a **type alias**: an
interface has no implicit index signature and fails the `AnyMap` constraint with a second,
confusing error.

#### The general rule, measured later

The paragraph above says alias instantiations expand. That is true and it is the narrow case.
Someone will read it, notice that tRPC's shared type is a plain `export type AppRouter =
typeof appRouter` with no transform anywhere, and conclude that the fix is to stop
transforming: have `defineContract` return everything `Client` needs so the user writes
`type App = typeof contract`.

That was proposed, and measured before building. It does not work, and it does not work for a
reason the narrow statement does not cover. Six forms against the contract pinned in
`scripts/check-hover.ts`, measured in one run, with the interface row reproducing the gate's
own numbers:

| form | emit | call | stream |
|---|---|---|---|
| `interface AppMap extends MapOf<typeof contract> {}`, then `Client<AppMap>` | **107** | **169** | **157** |
| `type App = typeof contract`, then `Client<MapOf<App>>` | 377 | 439 | 427 |
| `type AppAlias = MapOf<typeof contract>`, then `Client<AppAlias>` | 377 | | |
| no alias at all, `Client<MapOf<typeof contract>>` | 377 | 439 | 427 |
| a client parameterised by the **contract**, `ContractClient<App>`, no `MapOf` anywhere | **378** | 431 | 379 |
| the same, no alias | 378 | | |

Two things fall out of that table.

**A plain `typeof` alias does not preserve its name either.** Rows two, three and four are
byte-identical. `type App = typeof contract` is not an alias instantiation, and it expands
anyway, to the contract literal with `StandardSchemaV1<unknown, …>` in it.

**Removing the transform makes it one character worse.** Row five is the proposal taken as
far as it goes, with `MapOf` nowhere in the user's code, and it prints 378 against 377. What
expands is the contract literal, not the transform over it. (Rows five and six are only
comparable to the others on `emit`: that probe's `ContractClient` has a shorter parameter list
than the real `Client`, which is why its `call` and `stream` read low.)

So the rule to carry forward is broader than the one above:

> **Only an interface name survives being printed as a type argument.** A type alias over an
> instantiation does not, a `typeof` alias over an object literal does not, and an inline
> instantiation does not.

The interface line is therefore not a workaround for `MapOf`. It is the only construct
TypeScript prints by name in that position, and it would be required even if this library did
no transformation at all.

**Reconsider when:** TypeScript preserves alias names in hover output. Not merely alias
instantiations: row two is a plain `typeof` alias and expands too, so anything short of
printing aliases by name in type-argument position leaves this where it is.

### D101. A verification command that cannot report failure is the soak again
`export interface Register {}` was rewritten to `export type Register = {}` by `lint:fix`,
which silently broke module augmentation: a type alias cannot be augmented, so every
application's registration would have failed with "Duplicate identifier". It was pushed,
because the command that was supposed to catch it was

```
npx tsc -p tsconfig.register.json --noEmit 2>&1 | head -3 && echo "  program clean"
```

`head` exits 0 whatever `tsc` printed, so the confirmation always fired, directly beneath the
errors it was meant to be reading. Same shape as D85, where a soak printed `SOAK PASSED` over
`samples: 0`, and D87, where an aggregate over an empty collection satisfied every bound. The
constant is a step that reports success independently of what it examined.

**The repository's own scripts were checked and are clean.** `run-node-tests.sh` and
`check-node.test.sh` both set `-uo pipefail`, and the one place a pipe wraps the command under
test captures `PIPESTATUS[0]` explicitly. No npm script contains a pipe. The workflows pipe
only inside conditions, where a failure is the condition failing. So this was not a repository
defect; it was an ad-hoc command shape used while working, which is worth writing down
precisely because nothing gates it.

The rule: **never end a verification with a pipe into a pager or filter.** Check the exit code
directly, or use the filter only after the status has been captured.

**Two related sweeps, both clean.**

`interface AppMap extends MapOf<typeof contract> {}` is the single most load-bearing
declaration form in this project, and D57 measures what happens if it becomes a type alias:
hover goes from 107 characters to 377. Biome does not rewrite a non-empty `extends` interface,
verified against the real configuration. The pattern is safe from the fixer.

Every `biome-ignore` in the repository names a live rule. This is gated rather than reviewed:
biome reports `suppressions/unused` for a suppression that matches no diagnostic, and lint
fails on it. Verified by pointing one at the wrong rule and watching lint go red.

**Reconsider when:** a formatter or fixer gains the ability to rewrite `interface X extends Y
{}`, which would silently undo D57.

---

### D102. The ergonomic forms are how the library is shown, and the object form is documented once

Everything the 0.4.0 ergonomics work added was, until this pass, the *second* way each thing
was written. The documents still opened with the object literal, an explicit `<AppMap>` at
every construction site, a hand-written accept loop and `ctx.signal.throwIfAborted()` in a
generator that does not need it. A reader copies what is in front of them, so the older form
was still the real interface.

So every example in `README.md`, `API.md`, `AGENTS.md`, the site, and `examples/chat` now uses
`reliable` / `unreliable` / `rpc` / `streaming`, registers the map, and lets `listen(listener)`
own the accept loop. The object form is documented exactly once, in API.md §1.3, as the form
for a contract assembled programmatically, which is the one case a helper call cannot express.

`throwIfAborted()` survives in one place, in the streaming guide, next to the case that earns
it: long work *between* yields, where nothing else can interrupt.

**Reconsider when:** a helper cannot express something the object form can, other than
programmatic assembly. `id` was that case and it is covered by spreading:
`{ ...reliable<T>(), id }`.

### D103. A schema is a first-class choice, not a footnote

`type$` was in every example and validation was a subsection titled "bring-your-own", which
reads as the unusual option. It is the opposite: a server whose clients it does not control
should validate.

Both are now shown side by side wherever a contract is introduced, with the cost stated rather
than implied: a type argument is types-only and free at runtime, a schema validates every
inbound payload on arrival at one check per message. The recommendation is explicit - a schema
where an untrusted peer can reach, a type argument where both ends are yours and the traffic
is high.

This changes no code. `payload` accepted both before.

### D104. Each documentation snippet compiles as its own program

The docs gate compiled every generated snippet file in one `tsc` invocation. That was invisible
until snippets began registering a map, because `declare module 'transport-io'` is a global
augmentation: two documents registering different maps collided, and API.md's snippets then
type-checked against README's contract. The failure was in the gate, not the documents.

Each snippet is self-contained already, so the shared program contributed nothing except the
collision. One program per snippet costs 50 ms each and 2.5 s for the set, because TypeScript 7
is the native compiler.

Two blind spots were fixed in the same pass. A `standalone` block was compiled in isolation and
then *still* accumulated into the prefix for later blocks, so a page showing one construct two
ways failed as a duplicate declaration. And the import-deduplication regex never matched
`import type { … }`, so a type-only re-import was a duplicate identifier.

**Reconsider when:** the snippet count grows enough that per-file compilation is slow. The fix
then is to group by document, which is correct as long as no document registers twice.

### D105. `ServerPeer` and `RoomTarget` default to the registered map

`Client` and `Server` defaulted to `Registered` when registration shipped. `ServerPeer` and
`RoomTarget` defaulted to `AnyMap`, so a bare `ServerPeer` annotation accepted every event name
and every payload: registration appeared to work and bought nothing.

The type test that should have caught it asserted only that two server types differ, which is
true whatever the payload types are. It now asserts the payload types themselves, because
acceptance is exactly what `AnyMap` also gives.

---

### D106. The dev certificate is minted by shelling out to openssl, not in JavaScript

A pure-JS `mintDevCert()` was proposed, on two grounds: openssl on Windows is a support
burden, and owning the minting lets the hash come back as `Uint8Array` instead of hex a user
has to parse.

The second is already solved. `transport-io dev` returns the hash as bytes and publishes it
at a fixed endpoint, so nobody parses hex; that was the actual complaint, and it is fixed
without a DER encoder.

The first does not pay for what it costs. Issuing an X.509 certificate in JavaScript means
writing and maintaining an ASN.1 DER encoder for a TBSCertificate, ECDSA P-256 signing over
it, and the SAN extension - new cryptographic surface, in a library whose CLI currently has
no runtime dependencies at all, for a platform this project already does not support for
development (see "Platform support" in CLAUDE.md). Node cannot help: `crypto.Certificate` is
SPKAC only and there is no issuance API, which is why openssl is invoked in the first place.

**The known cost, recorded rather than fixed:** `transport-io dev` requires `openssl` on
`PATH`. It is present by default on macOS and on every mainstream Linux distribution, and the
CLI names the install command for the platform when it is missing. Windows contributors use
WSL, where it is present.

**Reconsider when:** somebody reports this as a real blocker rather than a theoretical one, or
Node gains a certificate-issuance API. The second removes the entire argument.

### D107. The receiver is the cost, and that is architectural

Recorded as an observation, not a proposal. Nothing here is scheduled.

Every row in D100's table prints the same shape:

```
(method) Client<M>.emit<"chat">(event: "chat", payload: { from: string; body: string; })
```

The payload is small in all six. The characters are `M` being printed into the receiver, on
every method, on every hover. That is a consequence of `Client` being a generic class: the
type argument is part of the receiver's type, so TypeScript prints it.

tRPC does not read lighter because it avoids a transform. It reads lighter because the router
type never reaches a printed signature. Procedures hang off a proxy and resolve through
indexed access to their own input and output types, so what you hover is the procedure, and
the router is nowhere in it. The difference is the shape of the surface, not the shape of the
type.

Adopting it here would mean the client's methods stop being methods on a generic class. That
is a 1.0-scale change to the entire public surface, and it is not worth doing for hover width
alone while the interface line costs one line and buys 107 against 377.

**Reconsider when:** the surface is being reworked for another reason at 1.0, at which point
this stops being a change of its own and becomes a property to design for. Not before.
### D108. Each transport constructs and connects, and the seam stays for three cases
`new Client({ contract, connect: () => connectDev() })` followed by `await client.connect()`
is two statements and an arrow whose only job is to defer a call the next line makes anyway.
Every transport module already knows it is building a client, so each one now exports a form
that does both: `devClient`, `browserClient`, `http3Client`, all resolving to a connected
client.

Three decisions inside that.

**New names rather than overloading the existing ones.** `connectDev` returns a `Connection`
and is a value you hand to `connect`. Making its return type depend on whether `contract` was
passed would mean the module stops having a one-sentence description, and the two layers stop
being separable. An extra export is cheaper than that.

**The map is a type argument and is never inferred from `contract`.** Inference is the
obvious thing and the wrong one: it resolves to `Client<MapOf<typeof contract>>`, which is
D100's 377-character row. The shorter spelling that compiles must not be the worse one, so
the parameter defaults to `Registered` instead. Omitting it therefore either works, because
the application registered a map, or fails with the sentinel naming the fix. There is no
third outcome, and `transport-clients.test-d.ts` pins it: weaken the default to `AnyMap` and
that file reports an unused `@ts-expect-error` rather than quietly accepting every event name.

**`new Client({ connect })` is not deprecated and is not going anywhere.** The rule for
choosing is that the one-call form hands back a client that is *already connected*, so
anything needing the client before then constructs it itself. Three cases qualify: a
transport of your own, React (`TransportProvider` takes an unconnected client and connects it
in an effect, so it must exist synchronously in a `useState` initialiser), and any page that
renders `connecting`, which is observable only while holding the thing doing the connecting.
Both pages in `examples/chat` show a status indicator and use the seam form for that reason,
which is why the examples do not match the README's canonical form and should not be
"corrected" to.

`Http3ClientOptions` was renamed to `Http3ConnectOptions` in the same change, so the three
modules name their connection options the same way and the client options could take the
obvious name.

**Reconsider when:** the third case stops being real, which would need a way to observe a
connection that does not yet exist. It is not obvious what that would look like.

### D109. The README's first screen is the pitch, the contract, the demo, and one command
Someone deciding whether to read on decides in seconds, and the first screen used to be
glibc 2.38 and Bun. D47's ordering, limitations above install, still holds; this moves both
below a first screen that shows the thing itself: the one-line pitch, the `defineContract`
teaser, the two-stream demo image, and `npx transport-io dev --demo`. The comparison with
Socket.IO follows, then the limitations, in full and prominently. Install caveats are
collapsed under a `<details>` in the install section. Nothing D47 required was removed.
Every limitation stayed, because they are the most credible thing in the repository.

### D110. Claims about other projects are sourced or cut
A third category of documentation drift, after stale and fabricated: confidently wrong about
someone else. Two entries in this ledger asserted things about Socket.IO from memory of how
such a system must work, and both were wrong about that one. D48 said its protocol was
undocumented; it is documented at two levels, with version history. ADR 0002 said a timer
runs per pending acknowledgement and that a slow response blocks the connection; the timer is
opt-in and a slow handler blocks nothing.

The rule: a sentence stating what another project does, does wrong, or fails to do carries a
link to that project's own documentation or source, or it is cut. Commentary about them is
not a source. When such a sentence is found to be wrong, the entry keeps the original wording
under an erratum rather than silently losing it. A ledger that quietly loses its errors is
worth less than one that carries them, because the error is the evidence that the category
exists.

Applied on 2026-09-01 to README.md, `packages/core/README.md`, CLAUDE.md, ADR 0002, D36's
rooms sentence, D48, and the site landing page. The README's comparison with Socket.IO was
written after reading their source, and states where they are the better choice inside the
section rather than in a footnote, because a comparison that omits that makes every other
line suspect.

### D111. Certificate renewal on the reference transport is a drained restart, not a reload
The umbrella package exposes `updateCert(cert, privKey)` and calls it on each transport only
`if (transport.updateCert)`. The quiche transport package, at 1.6.7, defines no such method
anywhere in its JavaScript or native sources, so on this stack the call is a silent no-op.
A deployment that renews a certificate therefore restarts the process. The public demo's
runbook, `examples/chat/deploy/README.md`, is written around that: the certbot deploy hook
restarts the unit, the process drains on SIGTERM, and every live session drops once per
renewal. The trigger to revisit is the transport gaining a real `updateCert`, at which point
the listener grows a matching method and the hook stops restarting.

### D112. A claim found false is retired as a pattern, not removed as a sentence
"`@transport-io/react` requires registration" was found stale three times and survived all
three sweeps. Not through disagreement; the mechanics of a sweep let it through three
different ways:

- **Each sweep was a list of files.** The targeted React review covered the React guide, the
  package README, getting-started's React section and API.md §7. AGENTS.md was on none of the
  lists, and it held the sentence throughout.
- **A grep is line-based, and the documents are hard-wrapped.** The sentence read "`is the
  one thing that` / `currently requires it`" across a line break, so a grep for the phrase
  found nothing even when AGENTS.md was finally searched.
- **The phrasing varied.** "requires it", "currently requires it", "the one thing that
  requires", and the correct sentence beside it, "does not need it either", share every
  keyword.

`scripts/check-retired-claims.ts` closes all three. A claim found false is retired as a
regular expression, matched against every tracked markdown file with whitespace collapsed
first, so a file off any list and a sentence that turns a corner are both seen. Each entry
carries the wording it was last seen as, and the gate proves every pattern against its own
wording before scanning, so a pattern that drifts until it matches nothing fails rather than
passing; that check fired on the first run, against a pattern this entry's author had just
written. The list only grows. Records that quote a retired claim to say it was wrong,
`DECISIONS.md`, `ADR/`, `KNOWN-ISSUES.md` and the changelogs, are the only exempt files.

On its first run the gate found two instances the sweep that prompted it had missed, in
`packages/react/README.md` and in CLAUDE.md. That is the fourth way, and it is the reason
this is a gate rather than a fourth sweep.

### D113. Example comments say what the next line does, never why it was chosen
The rule for reader-facing documents extends to the source under `examples/`: a comment says
what the next line does when that is not obvious, and never why it was chosen over something
else. An example is copied, and a six-line paragraph defending `new Client` over
`browserClient` travels with it into a codebase where nobody asked. Where the reason matters
to the reader it is one line stating the consequence: `// new Client, so the page can show
"connecting"`. The sweep took the nine TypeScript files of `examples/chat` from 1095 lines to
926 without changing a statement. The rationale stays where it was already recorded: D108 for
the seam form, D93 for the credit window, D111 for the restart on renewal.

### D114. `examples/react` is the example people copy; `examples/chat` stays vanilla
Most people who try this library will do so from React, and the example they copy did not
exist: the React binding had a Playwright fixture under `packages/react/e2e-app`, built to be
asserted on rather than read. `examples/react` is the chat with cursors from `examples/chat`
on `@transport-io/react`: `TransportProvider`, `useConnection`, `useEvent`, `useCall`, and
`useStream` for `/say`, under Vite with no state library, on `createHooks` because that is
the documented default and with no `declare module`. It sits under the same gates as the
vanilla example: `tsc -p examples/react` in the typecheck script and in CI, an e2e over real
QUIC that builds it with Vite and serves it through the real `dev` command, and the
docs-freshness hook, which now names `examples/` in its list when library source changes.

`examples/chat` stays vanilla. It is the core package's example and it shows the library with
nothing else in the way; a framework in it would make every reader who does not use that
framework translate.

### D115. The CLI is tested through the symlink npm runs it by
`npx transport-io dev --demo`, the first command in the README, exited 0 without printing a
line in 0.6.1 and 0.7.0. The entry guard added in 5f06c43 compared `process.argv[1]` with
`import.meta.url`. npm links a `bin` as a symlink, Node keeps the link in `argv[1]` and takes
the main module to its real path, so through the bin the two never matched and `main()` never
ran. Every test and every e2e invoked `node packages/core/dist/cli/main.node.js` on the real
path, which is why fourteen green e2e runs said nothing about it. It was found by the React
example's `npm run server` script, the first thing in this repository to run the bin as a bin.

Two changes. The guard compares real paths, and `entry.node.test.ts` runs the CLI through an
extensionless symlink, the shape npm creates, and requires the same output as the real path.
The root build also sets the execute bit on the emitted bin, which tsc does not; npm sets it
on a registry install, so only a clone lacked it, but a clone is where the examples'
`transport-io dev` scripts run. The rule: a `bin` is exercised through `node_modules/.bin`,
never only through `node` on the file, because the two differ in exactly the property an
entry guard reads.

