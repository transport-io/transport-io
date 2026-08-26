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

### D13. Memory growth is a Stage 1 graduation criterion, with numbers
Not "needs a soak run". **500 concurrent sessions, 50,000 `call` streams churned, 60
minutes, on the pinned Node / linux-x64.** Sample RSS after a forced GC every 5 minutes
from T+10min to T+60min and fit a line: **the slope must stay under 4 MB/h**, and absolute
RSS must stay under 600 MB. The 10-minute warmup excludes startup allocation.

The threshold was originally 5% growth between two point samples. That was wrong, and
wrong in a way worth recording: against #425's own rate of 16.7 MB/h, the 50-minute window
yields ~13.9 MB, which at any plausible baseline (300–500 MB) is 2.8–4.6% — **under the
threshold**. The criterion would have certified the exact leak it was written to catch.

Two lessons are now rules. A threshold stated as a proportion of a baseline we do not fix
in advance is unfalsifiable. And two point samples are not a slope; noise at either end
swamps the trend.

Rationale for the shape: #425 reported 500 concurrent reaching 700MB over 12h, and a
slope measurement catches that trend without a 12-hour job. Run manually before Stage 1,
**not on PRs** — it is too slow and too flaky for a merge gate, and putting it there would
get it disabled within a month. Failing it is a Stage 1 blocker.

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
place to live. Header cost rises from 7 to 11 bytes; conservative payload maximum falls
from 1017 to 1013. Core drops stale
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

Plus: squash merge only, linear history required, and no bypass for administrators on this
list. Until the remote exists these are unconfigured, so the pairing rule is currently
**asserted but not enforced** — that is a real gap and closing it is the first task when the
repository is pushed.

### D63. Development platform
macOS and Linux. Windows is unsupported for development: hook commands invoke
`./node_modules/.bin/` paths directly, which are `.cmd` shims on Windows, and the scripts
assume a POSIX shell. WSL works. This is separate from *running* the library, which is not
blocked on Windows — the transport publishes a `win32-x64` prebuild.

Recorded because the alternative is leaving it as an undocumented property of one machine,
the same category as the Node 20 gap below.

### D64. Node 22 is the development floor, and the local environment now matches
`engines: >=22`, and the local toolchain was Node 20.20.2 — a warning on install and a
wrong-environment bug the moment integration tests load the transport. Resolved before the
framer rather than after: Node 22.23.2 installed and set as the default.

The ADR 0006 runtime-split evidence (Bun segfault 3/3, Node 0/3) was gathered on Node 20 and
is re-run on Node 22 as part of Phase 2b, per the audit finding `runtime-evidence-is-eol-node`.
