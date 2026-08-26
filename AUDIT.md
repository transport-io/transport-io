# Pre-implementation audit

Adversarial pass over 42 decisions and 13 documents, before any code exists.
**54 findings raised, 49 upheld, 5 rejected.** Four passes: internal contradictions,
decisions resting on corrected evidence, superseded but not withdrawn, and normative prose
not traceable to a decision.

Every finding below was independently verified against the document text. Arithmetic
findings were recomputed rather than accepted.

---

## Blocking (6)

### B1. `numeric-event-ids` — the most consequential wire decision has no decision record
PROTOCOL.md §5.4 identifies events on the wire by 1-based positional index into the
sorted contract. Nothing in D1–D51 authorises it. It was invented while drafting prose.

**Resolution:** add it as a decision with its rationale (compactness on a 1017-byte
datagram budget) and its cost (positional identity is fragile across contract edits, which
is precisely why the fingerprint exists). Record the rejected alternative: string event
names, which cost 4–20 bytes per datagram.

### B2. `contract-fingerprint` — an entire cryptographic algorithm with no decision behind it
PROTOCOL.md §4.3 specifies a hash function, canonical serialisation, sort order, truncation
length and an exclusion rule. D34 states the handshake's contents **exhaustively** as
`{ v, feat }`. §4.1 adds a third field. `fingerprint` and `WT_CONTRACT_MISMATCH` return
zero hits across DECISIONS.md and all nine ADRs.

**Resolution:** promote to a decision, including why payload schemas are excluded from the
hash (a peer may validate more strictly) and why 8 bytes is enough (collision risk is
against accidental drift, not an adversary). Amend D34 to state three fields.

### B3. `length-max-off-by-four` — arithmetic error in the frame cap
§5.1 defines `Length` as counting bytes **after** itself: 4 header + payload. Its own
minimum (5 = 4+1) is consistent. Its maximum is not:

```
max valid  = 4 + 1048576 = 1048580
doc states = 1048584     = 8 + 1048576   <- counts the Length field twice
off by 4 bytes
```

**Resolution:** correct to `1048580`. Add the derived-value assertion to the constants test
so the two can never drift again.

### B4. `join-leave-have-no-event-id` — a conforming JOIN frame cannot be constructed
§5.2 defines `JOIN` and `LEAVE` as frame types. §5.4 defines Event ID as the contract
index and carves out `0x0000` for exactly three types: `HANDSHAKE`, `CALL_RESPONSE`,
`CALL_ERROR`. `JOIN` is not among them, and a room name is not a contract event, so no
legal Event ID exists for it.

**Resolution:** add `JOIN` and `LEAVE` to the `0x0000` carve-out.

### B5. `emit-stream-reset-kills-the-lane` — a recoverable error is fatal to the session
§1 says a protocol error resets a stream or closes the session per §10. There is exactly
**one** emit stream per direction (D32), so resetting it destroys all stream-lane traffic
for the session with no way to reopen. A single malformed frame becomes a silent, total,
unrecoverable loss of the emit lane.

**Resolution:** any protocol error on the emit stream escalates to a session close with the
appropriate code. Never a bare stream reset. State it in §5 and §10, because the
one-stream-per-direction design makes stream-level recovery meaningless here.

### B6. `soak-threshold-passes-the-leak` — the graduation criterion certifies the bug it exists to catch
D13 measures RSS growth between T+10min and T+60min against a 5% threshold. Recomputed
against the leak it targets:

```
#425 rate        : 16.7 MB/h   (500MB -> 700MB over 12h)
window           : 50 min
expected growth  : 13.9 MB
at 300MB baseline -> 4.63%   PASSES UNDETECTED
at 400MB baseline -> 3.47%   PASSES UNDETECTED
at 500MB baseline -> 2.78%   PASSES UNDETECTED
```

**Resolution:** replace the percentage with an absolute slope bound tied to the observed
leak: **RSS growth must stay under 4 MB/h**, roughly a quarter of #425's rate, measured by
linear fit over the final 50 minutes rather than two point samples. A percentage of an
unknown baseline is unfalsifiable.

---

## Contradictions between decisions (upheld: 12)

| id | conflict | resolution |
|---|---|---|
| `too-many-streams-open-vs-close` | D18 says reject further stream opens with `WT_TOO_MANY_STREAMS`; §10.2 makes it a **session close** code. Reject and close are different remedies. | Split: reset the offending stream with a new one-byte code; reserve the session close for repeated abuse. |
| `emit-cap-scope` / `one-mib-cap-applies-to-calls-too` | §5 scopes the layout to "every stream-lane and call-stream frame", so the 1 MiB emit cap silently binds `CALL_REQUEST` too. D32 scoped it to emits only. | State the cap per frame type. Calls get their own, larger bound. |
| `room-except` / `except-cannot-cross-the-bus` | API.md §2.3 ships `RoomTarget.except()`; the `Adapter` interface in D40 has no exclusion parameter, so exclusion cannot cross the bus and silently applies only to local peers. | Either add an exclusion set to `broadcast`, or drop `except()` from v1. Recommend adding it — self-exclusion is the common case and a local-only implementation is a correctness bug. |
| `nodeid-has-no-field` | D20 mandates tagging frames with an origin `nodeId`; §5.1 and §7.2 state fixed overheads of 8 and 7 bytes with no origin field. | Origin travels in the adapter envelope, not the wire frame. Say so explicitly in D20 — the frame the peer receives and the frame the bus carries are not the same bytes. |
| `staledropped-name-collision` | `staleDropped` names two different things: D15's sender-side TTL drop and D19's receiver-side sequence drop. | Rename the receiver-side one to `staleReceived`. |
| `call-error-carries-local-only-codes` | §6.4 says `CALL_ERROR` carries a code from §10.1 or §10.3, but §10.3 is defined as never transmitted. | Restrict `CALL_ERROR` to §10.1. |
| `returns-implies-callable-unconstrained` | `Callable<C>` filters on `returns` and never inspects `lane`, so a datagram event with `returns` is callable — over a lane with no response path. | Constrain `EventDef`: `returns` is only valid with `lane: 'stream'`. Enforce in the type, not in prose. |
| `d29-commit-body-self-contradiction` | D29 says the PR body becomes the commit body and `BREAKING CHANGE:` footers are authored there, then says no commit ever has a body. | The amended rule wins: `!` marker, squash set to "Pull request title only". Remove the footer sentence. |
| `d29-scopes-invalidated-by-d43` | D29's example scopes include `fix(react):`; D43 removes every package except `core`. Scope validation against the workspace list would reject the documented example. | Update the examples to packages that exist. |
| `feat-intersection-gated-on-wrong-axis` | D34 gates feature intersection on "From Stage 1"; §4.2 gates it on "From protocol version 1". These are different axes and can diverge. | Gate on protocol version. Stage is a publishing state, not a wire property. |
| `zero-or-many-call-responses` | PROTOCOL.md permits zero `CALL_RESPONSE` frames; API.md types `call()` as `Promise<ReturnOf<...>>` with no empty case. | Require exactly one response frame in v0, keeping the multi-frame shape reserved. |
| `protocol-error-two-numbers-one-name` | `WT_PROTOCOL_ERROR` is both reset code 3 and close code 1004; `WT_NO_ERROR` is 0 in both spaces. | Intentional, but the constants test must key on (space, code), not name alone. Document it. |

---

## Decisions resting on corrected evidence (upheld: 10)

| id | issue | resolution |
|---|---|---|
| `slim-tag-rule-underspecified` | F2's rule names specific tags, but the disqualifying property is glibc < 2.38. Any future tag inherits the problem silently. | State the property, not the tag list. Add a CI assertion on the runtime's glibc version. |
| `safari-revisit-trigger-superseded` | D11's trigger says `WT_MAX_DATA` in the binary, but the verified root cause is missing **SETTINGS**, not capsules. | Retarget the trigger to the SETTINGS names, which is what actually unblocks Safari. |
| `node-reliability-vocabulary` | D10 mixes the library's `reliability` strings with the browser's. | Name which vocabulary applies per side. |
| `runtime-evidence-is-eol-node` | The Bun-vs-Node segfault evidence was gathered on Node 20, now EOL. | Re-run the comparison on the pinned Node before Phase 2b. The conclusion is unlikely to move; the evidence should not be stale. |
| `deno-second-implementor-fails-f8-criterion` | ADR 0007 cites Deno as a credible second implementor, but F8 disqualifies flag-gated runtimes. | Apply the same standard to both or state why Deno differs. |
| `datagram-diagram-24-bit-sequence` | Measured: the §7.1 ASCII diagram draws Codec(8) in 15 cells, Event ID(16) in 31, Sequence(32) in 15. The field budget table is correct; the diagram is not. | Redraw. Add a test asserting drawn widths match the budget table. |
| `stale-decision-cross-references` | Two internal pointers resolve to the wrong decision. | Fix; add a link-check to the docs gate. |
| `handshake-frame-fields-diverge-from-d34` | D34 says two fields, §4.1 shows three. | Same fix as B2. |
| `datagram-seq-scope-under-fanout` | D19 scopes sequence per `(session, event)`, undefined when a frame is fanned out from another node. | Sequence is assigned by the **sending session**, re-stamped per outbound session. Say so. |
| `sequence-wrap-rule` | The circular comparison is stated ambiguously. | Give the exact expression and a test vector at the wrap boundary. |

---

## Superseded but not withdrawn (upheld: 8)

- `d33-names-a-code-that-does-not-exist` — `WT_HANDSHAKE_NOT_COMPLETE` survives at D33:496 only; everywhere else uses `WT_HANDSHAKE_INCOMPLETE`. **I found this one independently before the audit landed.** Fix the name and distinguish the deleted session-close rule from the surviving stream reset code.
- `three-stream-kinds-fossil` — §3 says "three kinds of QUIC stream" while its own table lists two plus datagrams. Fossil of the pre-amendment handshake stream.
- `d29-body-rule-self-superseded` — see contradictions table.
- `type-dollar-rename` — D17 says `Type<T>()`, API.md ships `type$<T>()`.
- `hostile-adapter-public-subpath` — D40 calls it test-only; API.md §5 documents it at a public import path.
- `e2e-gate-before-e2e-exists` — D31 makes Playwright a required check on a tooling-only first commit.
- `room-not-joined-unreachable` — `WT_ROOM_NOT_JOINED` is defined but no documented API path reaches it.
- `drop-counters-have-no-api-surface` — D15 mandates exposing `droppedDatagrams`/`queueDepth`; API.md exposes neither.

---

## Untraceable normative prose (upheld: 13)

Invented while drafting, now needing decisions: the stream frame header layout itself,
frame type and codec numeric assignments, ten of eighteen `WT_*` names, `host` and `path`
defaults, `except()`, `type$<T>()`, the 1 MiB cap, and the sequence wrap rule.

Checked clean and correctly traceable: the 5000 ms handshake deadline (D33), the 1024-byte
close-reason cap (D36), the one-byte reset range (D36), the 64/256/16 bounds and 150 ms TTL
(D15), the 1024 datagram floor and `maxPayload = effective − header` derivation (D19),
codec `0x01`/`0x00` (D37), and the whole binding surface table (D41). The §4.3 worked
fingerprint is arithmetically correct — recomputed as `ef8e824fd4867bb0`.

**Resolution:** each becomes a numbered decision before Phase 2. The traceability test in
the docs gate then keeps the property.

---

## Rejected (5)

- `error-code-assignments` — inverts D36, which explicitly delegates the table to PROTOCOL.md.
- `stream-frame-header-layout` — reduces to "the wire spec specifies the wire", though the
  narrower point that the layout has no decision is upheld separately.
- `baseline-coverage-includes-unsupported-safari` — the documents already address it
  explicitly; F9 is a claim about the feature, D11 about our server.
- `datagram-floor-vs-reported-max` — the texts do not conflict under a reasonable reading.
- One duplicate.
