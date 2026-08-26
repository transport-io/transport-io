# transport-io wire protocol

**Protocol version: 0. Unstable.** During Stage 0 both peers require exact version
equality and refuse the session otherwise. The negotiation mechanism described in §4
exists; the compatibility promise does not.

This document is the specification. It is written so that an implementer with no access to
the reference source — someone writing a Go server, for instance — can build an
interoperable peer from this document alone. Where the reference implementation and this
document disagree, this document is correct and the implementation is a bug.

---

## 1. Conventions

All multi-byte integers are **unsigned big-endian** (network byte order).

Field widths are written as `(N)` meaning N bits. `u8`, `u16`, `u32` mean unsigned
integers of 8, 16 and 32 bits.

"MUST", "MUST NOT", "SHOULD" and "MAY" carry their usual specification force.

A **protocol error** means the receiver MUST NOT process the offending data. Whether it
<!-- norm: protocol-error-not-processed -> packages/core/src/framer.test.ts -->
resets a stream or closes the session is specified per case in §10.

---

## 2. Transport requirements

transport-io runs over **WebTransport on HTTP/3 (QUIC) only**.

A peer MUST NOT establish or accept a session over WebTransport on HTTP/2. That mapping
retransmits lost data, which would make the datagram lane (§7) reliable and ordered while
the contract continues to advertise it as unreliable. Silently changing a guarantee the
application declared is the specific failure this protocol exists to prevent.

Servers MUST refuse HTTP/2 WebTransport sessions rather than downgrading. This is the
enforcement point: a server that never offers the HTTP/2 mapping cannot be negotiated into
it, regardless of client behaviour. Clients SHOULD additionally request unreliable-capable
sessions where the platform exposes that control, and MUST refuse a session it can observe
<!-- norm: reliable-only-refused -> packages/core/src/protocol-promises.test.ts -->
to be reliable-only.

There is no fallback to WebSocket or any other transport, under any condition.

---

## 3. Streams and their roles

A session uses two kinds of QUIC stream, plus datagrams.

| purpose | stream kind | lifetime |
|---|---|---|
| Emit lane | one **unidirectional** stream per direction | whole session |
| Call | one **bidirectional** stream per call | one request/response exchange |
| Datagram lane | not a stream | — |

### 3.1 The emit lane

Each peer opens **exactly one unidirectional stream** for the whole session and writes all
of its stream-lane traffic to it, framed per §5. The client's emit stream carries
client-to-server traffic; the server's carries server-to-client traffic.

Frame 0 of the emit stream is always the handshake (§4). Because QUIC guarantees in-order
delivery **within** a stream, no other stream-lane frame can be observed before the
handshake. This removes the early-traffic race by construction rather than guarding
against it.

**Consequence, stated plainly: head-of-line blocking on the emit lane is cross-room.** All
rooms share one emit stream per direction, so a high-volume room delays a quiet room's
messages to the same peer. Calls and datagrams are unaffected — they use separate streams
and separate packets — but emits to one peer are serialised across every room that peer
belongs to. Implementers should not describe the emit lane as offering per-room
independence.

A per-room emit lane is reserved as the `emit-per-room` feature token (§4.2) and is not
part of version 0.

### 3.2 Call streams

Each call opens a **new bidirectional stream**. The initiator writes one `CALL_REQUEST`
frame and then closes its send side (sends FIN), which signals end of request. The
responder writes exactly one `CALL_RESPONSE` frame, or exactly one `CALL_ERROR` frame, and
then closes its send side. Receivers accept any number (§6.3).

There are no correlation identifiers, because the stream **is** the correlation. A stalled
call therefore cannot block another call: QUIC flow control applies per stream.

**The response is a sequence of frames terminated by stream close, not a single frame with
a length.** Version 0 senders emit exactly one `CALL_RESPONSE` frame, but receivers MUST
<!-- norm: receiver-accepts-multi-frame-response -> UNPROVEN: no test sends more than one CALL_RESPONSE on a stream; D7 reserves the shape for token streaming and nothing produces it yet -->
accept any number, so that incremental responses can be added later without a protocol
break.

---

## 4. Handshake

### 4.1 Frame

Each peer writes exactly one `HANDSHAKE` frame as frame 0 of its emit stream, immediately
on session establishment. The payload is a JSON object:

```json
{ "v": 0, "feat": [], "events": [["chat", 836792189, "stream"]] }
```

| field | type | meaning |
|---|---|---|
| `v` | integer | Protocol major version. |
| `feat` | array of string | Feature tokens this peer supports. May be empty. |
| `events` | array | Event table, §4.3. |

A peer MUST send its handshake without waiting for the other side's.
<!-- norm: handshake-sent-without-waiting -> packages/core/src/protocol-promises.test.ts -->

**Deadline: 5000 ms.** If a peer has not received a valid handshake frame within 5000 ms
of session establishment, it MUST close the session with `WT_HANDSHAKE_TIMEOUT` (§10.2).
<!-- norm: handshake-deadline-closes-session -> packages/core/src/api-hardening.test.ts -->

A peer that never opens its emit stream is indistinguishable from one that opens it and
never writes, so the same deadline covers both. This matters in practice: some clients
establish a WebTransport session successfully and then never transmit application bytes.
Without the deadline that state is a silent hang.

### 4.2 Version and feature negotiation

`v` mismatch: the session is refused with `WT_PROTOCOL_VERSION_MISMATCH` (§10.2).

During Stage 0 the comparison is **exact equality**. From protocol version 1 onward, a
major mismatch refuses the session and the active feature set is the **intersection** of
the two `feat` arrays, so older peers keep working and newer ones enable extras.

Feature tokens are short lowercase ASCII. Reserved and unimplemented in version 0:

| token | meaning |
|---|---|
| `emit-per-room` | Separate emit stream per room (§3.1). |
| `codec-msgpack` | MessagePack codec, codec id to be assigned (§5.3). |
| `session-resume` | Resumption of a prior session's identity and membership. |

An unrecognised token MUST be ignored, not treated as an error.
<!-- norm: unknown-feature-token-ignored -> packages/core/src/protocol-layers.test.ts -->

### 4.3 Contract identity

Peers exchange their **event table** and compare it per event. There is no whole-contract
hash, because an all-or-nothing comparison refuses a session over differences that do not
matter. See ADR 0011.

The `events` field of the handshake is an array of `[name, id, lane]` triples, sorted
ascending by name by Unicode code point:

```json
{ "v": 0, "feat": [],
  "events": [["chat", 836792189, "stream"], ["cursor", 1185214141, "datagram"], ["save", 360565394, "stream"]] }
```

Each peer compares the two tables entry by entry:

| condition | outcome |
|---|---|
| Same name, different `lane` | **Refuse**, `WT_CONTRACT_MISMATCH`. The peers disagree about a delivery guarantee the application depends on. |
| Same name, different `id` | **Refuse**, `WT_CONTRACT_MISMATCH`. A genuine decoding disagreement. |
| Same `id`, different name | **Refuse**, `WT_CONTRACT_MISMATCH`. Collision override disagreement. |
| Name known to one peer only | **Proceed.** Sending it yields a per-message `WT_UNKNOWN_EVENT`. |

A refusal MUST name the offending event in the close reason, for example
<!-- norm: refusal-names-the-event -> packages/core/src/protocol-promises.test.ts -->
`event 'cursor' is 'datagram' here and 'stream' at the peer`.

**Property worth knowing before you deploy: the server sends its event table to every peer
that completes a handshake.** Anyone who can open a session learns the full set of event
names and lanes — not payloads, not schemas, not data, but the surface. For almost every
application this is uninteresting, and it is the same information a client bundle already
contains. It is stated here rather than left to be discovered because it is occasionally
not uninteresting: if event names encode unreleased features or internal structure, an
unauthenticated peer can read them.

**This library authenticates nothing, and offers no hook to.** `Connection` exposes no
headers, no URL, no peer address and no identity; `ServerOptions` has no reject callback;
and the handshake payload is exhaustively `{ v, feat, events }`. The only control an
application has is whether to call `accept()` on a connection at all — and the transport
listener hands it nothing to decide on. Note also that `accept()` writes the full event
table before `onSession` fires, so the disclosure described above happens **before** any
application code runs; refusing the peer afterwards does not undo it.

If event names are sensitive, the mitigation is at a layer below this one: terminate the
HTTP/3 request behind something that authenticates, and do not route unauthenticated peers
to the WebTransport endpoint at all. Earlier drafts of this section told operators to "gate
session establishment behind authentication", which read as a feature of this protocol. It
is not one.

**Payload schema shape is not exchanged and not compared.** A schema disagreement produces
one `WT_VALIDATION_FAILED` on one message, which is local, readable and recoverable. An
identity disagreement corrupts every message of that type, silently. The handshake refuses
what cannot be caught later and permits what can — so adding an optional field to a payload
is not a breaking change, and adding or removing an event is safe during a rolling deploy.

### 4.4 Ordering of the two checks

The event table is validated **first**, and conflicts are fatal. `feat` is negotiated
**second**, and is never fatal. They are independent axes: no feature token rescues a lane
disagreement, and no agreement about lanes implies a shared feature set.

## 5. Frame layout on streams

Every stream-lane and call-stream frame uses this layout. QUIC streams are byte streams
and **do not preserve write boundaries** — a single write may be delivered as many reads,
and many writes may be delivered as one — so the length prefix is the only way to recover
frame boundaries.

```
 0                   1                   2                   3
 0 1 2 3 4 5 6 7 8 9 0 1 2 3 4 5 6 7 8 9 0 1 2 3 4 5 6 7 8 9 0 1
+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+
|                          Length (32)                          |
+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+
|    Type (8)   |   Codec (8)   |          Reserved (16)        |
+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+
|                         Event ID (32)                         |
+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+
|                         Payload (*)                           |
+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+
```

### 5.1 Field budget

| field | bytes | notes |
|---|---|---|
| Length | 4 | Counts every byte **after** this field: 8 header bytes plus payload. |
| Type | 1 | §5.2 |
| Codec | 1 | §5.3 |
| Reserved | 2 | MUST be zero. Rejected as a protocol error otherwise. |
<!-- norm: reserved-field-zero -> packages/core/src/framer.test.ts -->
| Event ID | 4 | §5.4 |
| **Fixed overhead** | **12** | 4 length + 8 header |
| Payload | 1 to 1 048 576 | |

`Length` MUST be at least **9** — eight header bytes plus at least one payload byte.
<!-- norm: length-minimum-nine -> packages/core/src/framer.test.ts -->

**A `Length` of 0 is a protocol error.** So is a payload of zero bytes. Stream close is the
terminator for a call response (§3.2), so no zero-length sentinel is needed anywhere in
this protocol, and permitting one is actively harmful: at least one widely used QUIC stack
halts on a zero-length application write. Receivers MUST reject such a frame rather than
<!-- norm: zero-length-payload-rejected -> packages/core/src/framer.test.ts -->
forward it.

`Length` exceeding `1048584` (1 MiB payload plus the 8 header bytes it counts) is a
protocol error. `Length` counts only bytes *after* itself, so the four bytes of the Length
field are not included — the same convention its minimum of 9 already reflects.

The 16 MiB cap applies to the **call frames** — `CALL_REQUEST`, `CALL_RESPONSE` and
`CALL_ERROR` — because a call is the documented home for payloads too large to emit and
inheriting the emit cap would leave them nowhere to go. **Every other frame type is capped
at 1 MiB**, including `EMIT` and the control frames, which are orders of magnitude smaller
in practice.

A receiver MUST decide the cap from the frame type rather than applying the largest one
<!-- norm: cap-decided-by-frame-type -> packages/core/src/inbound-guards.test.ts -->
universally. The type byte is at a fixed offset inside the header, so it is readable before
any payload has to be buffered; applying the call cap to an `EMIT` frame lets a peer make a
receiver hold sixteen times what this section permits.
Exceeding either cap is a protocol error raised by the decoder as
`WT_PAYLOAD_TOO_LARGE` — not a §10.1 reset code, which is a distinction this document
previously got wrong. On a call stream the receiver abandons the stream, and the
initiator's call rejects with `WT_PROTOCOL_ERROR` because no response frame arrived. On
the emit stream, §5.5 applies.

### 5.5 Errors on the emit stream escalate

There is exactly one emit stream per direction and no way to reopen it, so resetting it
would destroy all stream-lane traffic for the rest of the session with no recovery path.

A protocol error detected on the emit stream therefore **closes the session** with the
corresponding code from §10.2. It never resets the stream. This is the one place where a
frame-level fault is deliberately escalated to a session-level one, and the reason is
structural rather than cautious: stream-level recovery is meaningless when the stream is
the lane.

### 5.2 Type

| value | name | valid on |
|---|---|---|
| `0x00` | reserved, invalid | — |
| `0x01` | `HANDSHAKE` | emit stream, frame 0 only |
| `0x02` | `EMIT` | emit stream |
| `0x03` | `CALL_REQUEST` | call stream, first frame only |
| `0x04` | `CALL_RESPONSE` | call stream |
| `0x05` | `CALL_ERROR` | call stream, terminal |
| `0x06` | `JOIN` | emit stream, server to client only |
| `0x07` | `LEAVE` | emit stream, server to client only |
| `0x08`–`0xFF` | reserved | — |

Receiving a reserved or contextually invalid type is a protocol error.

### 5.3 Codec

| value | name |
|---|---|
| `0x00` | reserved, invalid |
| `0x01` | JSON, UTF-8 encoded |
| `0x02`–`0xFF` | reserved |

Version 0 peers MUST send `0x01` and MUST reject any other value with
<!-- norm: codec-must-be-json -> packages/core/src/framer.test.ts -->
`WT_UNSUPPORTED_CODEC`.

`0x00` is permanently reserved as invalid so that a zero-filled buffer can never parse as a
valid frame. This is deliberate and cheap corruption detection.

### 5.4 Event ID

The **first four bytes of SHA-256 of the event's name**, big-endian, as a `u32`.

Identity is derived from the name, never from position. Two peers computing an ID for the
same name therefore always agree, and adding, removing or reordering events changes no
existing identifier — which is what makes a contract change survivable during a rolling
deploy. See ADR 0010.

Two names in one contract whose hashes collide are a **contract construction error**,
reported when the contract is built, naming both events. The fix is an explicit `id` on one
of them, which becomes part of the contract and is therefore shared by both peers.

`0x00000000` means **not applicable** and is used by `HANDSHAKE`, `CALL_RESPONSE`, `CALL_ERROR`,
`JOIN` and `LEAVE` — every frame whose meaning comes from the stream or from its own
payload rather than from the event table. A room name is not a contract event, so `JOIN`
and `LEAVE` have no event identity to carry.

An Event ID that does not correspond to a contract entry is answered with
`WT_UNKNOWN_EVENT`. This is a per-message error, not a session fault: peers running
adjacent contract versions legitimately know different event sets (§4.3).

---

## 6. Message types

### 6.1 `EMIT`

Fire and forget, on the emit stream. Payload is the encoded event payload. There is no
acknowledgement and no response.

### 6.2 `CALL_REQUEST`

The first and only frame the initiator writes on a call stream, followed by FIN. Payload is
the encoded request payload.

### 6.3 `CALL_RESPONSE`

Written by the responder on the call stream, then stream close. Payload is the encoded
response payload. Event ID is `0x0000`.

A version 0 responder MUST write **exactly one** `CALL_RESPONSE`, or one `CALL_ERROR`, and
never zero of both. A receiver MUST nonetheless accept a sequence of any length, so that
<!-- norm: call-response-sequence-any-length -> packages/core/src/call.test.ts -->
incremental responses can be added later without a protocol break — that asymmetry is
deliberate and is what keeps the door open for streaming responses.

### 6.4 `CALL_ERROR`

Written by the responder instead of any `CALL_RESPONSE`, then stream close. Terminal.
Event ID is `0x0000`. Payload is a JSON object:

```json
{ "code": "WT_VALIDATION_FAILED", "message": "field 'body' must be a string" }
```

| field | type | meaning |
|---|---|---|
| `code` | string | A code from §10.1. Local codes (§10.3) are never transmitted. |
| `message` | string | Human-readable, stating what to do about it. |

### 6.5 `JOIN` and `LEAVE`

Server to client only, on the server's emit stream. Payload is a JSON object
`{ "room": "lobby" }`.

**Rooms are server-authoritative.** A client cannot join or leave by sending a frame; a
client-sent `JOIN` or `LEAVE` is a protocol error. These frames exist so a client can
maintain an accurate view of its own membership. An application that wants client-initiated
subscription implements it as a call, which is already the authenticated path.

---

## 7. Datagram lane

### 7.1 Layout

```
 0                   1                   2                   3
 0 1 2 3 4 5 6 7 8 9 0 1 2 3 4 5 6 7 8 9 0 1 2 3 4 5 6 7 8 9 0 1
+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+
|   Codec (8)   |                 Event ID (32)                 |
+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+
|  ...Event ID  |                  Origin (32)                  |
+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+
|   ...Origin   |                 Sequence (32)                 |
+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+
|  ...Sequence  |                  Payload (*)                  |
+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+
```

There is no length prefix: a datagram is a message, and its boundary is the datagram
itself.

### 7.2 Field budget

| field | bytes | notes |
|---|---|---|
| Codec | 1 | Same table as §5.3. |
| Event ID | 4 | Same rules as §5.4. `0x00000000` is invalid here. |
| Origin | 4 | §7.3 |
| Sequence | 4 | §7.3 |
| **Fixed overhead** | **13** | |
| Payload | 1 to `limit − 13` | §7.4 |

A zero-length payload is a protocol error, as on streams (§5.1).

### 7.3 Sequence

**Origin** identifies the peer that produced the datagram. It is stamped once by the
session host that owns that peer and is never rewritten in transit.

Origin is **allocated, not derived**. A hash of the `PeerId` would carry the same birthday
problem as a hashed event ID — roughly 0.01% at 1,000 concurrent peers and 1.2% at 10,000
— and a collision here is close to undebuggable from outside: two peers silently share a
sequence space and each discards the other's datagrams as stale. Allocation removes the
class of failure instead of making it rare.

The normative requirements are:

1. **Who assigns it.** The session host that accepts the peer, at session establishment,
   before any datagram is sent.
2. **Uniqueness scope.** An origin MUST be unique among all peers concurrently connected to
<!-- norm: origin-unique-and-quarantined -> packages/core/src/protocol-layers.test.ts -->
   the same deployment — not merely to the same process. Uniqueness within one process is
   not uniqueness across a bus.
3. **Reuse, via quarantine.** An origin MUST NOT be reissued while any peer that observed
   it may still hold sequence state for it. It MAY be reissued once that is impossible.

   Never reusing would make the counter a clock rather than a capacity limit: 2²² values
   at 100 sessions per second exhausts in 11.7 hours and at 500 per second in 2.3 hours,
   so a busy host would stop accepting sessions and need a restart. That is a scheduled
   outage disguised as a safety property, and it arrives in production because it is a
   function of uptime multiplied by load rather than of anything testable.

   Reuse is safe because both windows that could confuse a reused origin are bounded by
   values this protocol sets:

   - **Receiver sequence-state retention.** A receiver MUST discard its
<!-- norm: sequence-state-retention -> packages/core/src/protocol-layers.test.ts -->
     `(origin, event)` sequence state after `60` seconds with no datagram for that pair.
   - **Maximum in-flight datagram lifetime.** A datagram older than the send-queue TTL
     (§9, 150 ms) is never transmitted, so an in-flight datagram cannot outlive that TTL
     plus network transit.

   **A released origin is therefore quarantined for at least `120` seconds** — twice the
   longer of the two bounds — before returning to the pool. There is no mechanism by which
   a datagram or a sequence entry survives that interval.

   With quarantine, steady-state occupancy is `concurrent + churn × 120s`. At 500 sessions
   per second that is 60,000 values, 1.4% of the space; at 20,000 per second it is 2.4
   million, 57%. Exhaustion becomes a genuine **limit on concurrency**, roughly 4.2 million
   live-plus-quarantined sessions per host, and never a function of how long the host has
   been up. A host that actually reaches it MUST refuse new sessions with
<!-- norm: host-ordinal-exhaustion-refuses -> UNPROVEN: needs a host that has genuinely exhausted its ordinal space; the allocator branch is covered, the refusal of new sessions is not -->
   `WT_TOO_MANY_STREAMS`-style clarity rather than wrap, because at that point the limit is
   real.
4. **Across processes.** A single-process deployment MAY use a plain monotonic counter
   with the quarantine above. A deployment with more than one session host MUST partition
   the space so that two hosts cannot issue the same value. The recommended partition is a
   10-bit host ordinal in the high bits and a 22-bit per-host counter in the low bits.

   **Stated limit: 1,024 concurrent session hosts.** This is a real ceiling, not an
   implementation detail, and a deployment approaching it needs a wider origin field
   negotiated through a `feat` token rather than a workaround.

   Allocating the host ordinal is the adapter's responsibility. `MemoryAdapter` is a single
   host and uses ordinal `0`. A cross-process adapter MUST provide a distinct ordinal per
<!-- norm: host-ordinal-partitioned -> packages/core/src/protocol-layers.test.ts -->
   host and MUST NOT hand the same ordinal to two live hosts.

   **Ordinals are recycled under the same rule**, because autoscaling churns hosts and a
   1,024-value space would otherwise exhaust for the same reason the counter would. When a
   host leaves, every session it owned ends, and receivers discard the corresponding
   sequence state within the 60-second retention window. An ordinal is therefore
   quarantined for at least `300` seconds before reallocation — longer than the
   per-origin quarantine because host departure is detected less promptly than session
   close, and because ordinal churn is slow enough that the extra margin costs nothing.

`0x00000000` is reserved and MUST NOT be allocated, so a zero-filled buffer cannot parse as
<!-- norm: origin-zero-reserved -> packages/core/src/protocol-layers.test.ts -->
a valid datagram from a real peer.

**Sequence** is a `u32` counter, monotonically increasing per `(origin, event)`, starting
at 1 and wrapping to 1 after `0xFFFFFFFF`.

Receivers apply **last-write-wins** keyed on `(origin, event)`: a datagram whose sequence
is not greater than the highest already seen for that pair is discarded and counted.

Scoping to the origin rather than to the transport session is load-bearing under room
fan-out, and the session-scoped alternative is broken in two distinct ways. A broadcast
encodes one frame and hands the same bytes to every recipient (§ADR 0005: frames cross the
adapter boundary as bytes, never re-encoded per recipient), so a sequence meaningful to one
receiving session cannot be meaningful to another. And if the counter belonged to the
receiving session, every originating peer would be multiplexed onto it: a peer that has
been sending for a minute reaches sequence 3000, a peer that just joined starts at 1, and
the newcomer's datagrams are discarded **forever** as "not greater than the highest already
seen". Keying on the origin makes one encoding correct for every recipient and keeps each
sender's stream independent.

Origin is **allocated by the server, never hashed** — see the top of this section, which
this paragraph contradicted for as long as both existed. The collision analysis that used
to sit here described a design that was rejected precisely because it had one; it is kept
below only as the argument against, and applies to no conforming implementation.

Were Origin a 32-bit hash, distinct peers would collide with probability approximately
`n² / 2³³` — about one in eight thousand at 1,000 concurrent peers, and about 1% at 10,000.
A collision degrades rather than corrupts: two peers share a last-write-wins slot for one
event, so one of them loses updates it should have kept. The datagram lane already permits
loss, which is why this is an acceptable trade against four more header bytes on the lane
whose whole purpose is being small.

This field is also what `ADR 0005`'s self-publish dedupe needs: a node receiving its own
broadcast back identifies it by origin. Wrap is detected
by treating the comparison as circular over the 32-bit space, with a difference greater
than `0x7FFFFFFF` read as wrap rather than regression.

This is in the protocol rather than left to applications because every realistic datagram
payload — a cursor position, a presence beat, an object transform — is last-write-wins, and
requiring each application to rebuild it is exactly the too-raw-primitive mistake this
library exists to avoid. An application that genuinely wants unfiltered delivery disables
the check per event; the field remains on the wire either way.

### 7.4 Size ceiling

The usable datagram size is a **runtime property of the path, not a constant.** It varies
with path MTU, and some hosting platforms reduce it further — Fly.io, for example,
documents taking roughly two dozen bytes off the MTU for its UDP routing. Implementations
MUST query the transport at send time rather than assuming a fixed value.
<!-- norm: datagram-max-queried-at-send-time -> packages/core/src/protocol-layers.test.ts -->

The maximum payload is:

```
maxPayload = effectiveDatagramSize − 13
```

where `effectiveDatagramSize` is the transport's reported maximum, or **1024** when the
transport reports zero or does not report one. 1024 is the conservative floor, chosen
because at least one major browser hardcodes exactly that value regardless of the true path
MTU. The corresponding conservative payload maximum is **1011 bytes**.

A sender MUST check the payload against this limit **before** writing. It MUST NOT rely on
<!-- norm: sender-checks-datagram-size-first -> packages/core/src/datagram-lane.test.ts -->
the transport to report an oversized datagram, because at least one widely used
implementation accepts the write, discards the datagram, and reports success. Exceeding the
limit raises `WT_DATAGRAM_TOO_LARGE` locally and transmits nothing.

### 7.5 What the datagram lane does not guarantee

Stated explicitly, because inference is not good enough for a guarantee this load-bearing.
On the datagram lane:

- **Delivery is not guaranteed.** Any datagram may be lost, and loss is not reported.
- **Ordering is not guaranteed.** Datagrams may arrive in any order relative to each other.
- **Uniqueness is not guaranteed by the network.** Duplicates are possible; §7.3 discards
  them at the receiver.
- **There is no acknowledgement**, no retransmission and no delivery receipt.
- **There is no flow control feedback.** A sender cannot learn that a receiver is behind.
- **Ordering relative to the stream lane is not guaranteed.** A datagram sent after an emit
  may arrive before it, and vice versa.
- **A datagram arriving before the handshake completes is discarded silently.** This is
  consistent with every point above and is not an error condition.

Applications requiring any of these properties MUST declare the event on the stream lane
<!-- norm: datagram-guarantees-need-stream-lane -> packages/core/src/lane-integrity.test.ts -->
instead. The lane is declared in the contract precisely so this choice is explicit and
visible in the type system.

---

## 8. Abort and stream reset

Cancelling a call maps to a QUIC stream reset carrying an application error code. It costs
no application-level message and requires no cooperation from the peer, which is the main
reason calls are modelled as streams.

The initiator resets its send side and stops reading; the responder observes the reset and
SHOULD abandon the work.

**Stream reset codes are one byte, values 0 to 255.** This is a protocol-wide constraint,
not an implementation limit: the WebTransport specification's browser API clamps stream
error codes to a single octet, so any wider code space would be untransmittable from a
browser peer. Implementations MUST NOT define reset codes outside this range.
<!-- norm: reset-codes-one-byte -> packages/core/src/protocol-promises.test.ts -->

---

## 9. Backpressure and drop policy

Normative for a conforming sender, because these choices are observable to the peer.

| lane | bound | on overflow |
|---|---|---|
| Datagram, per peer | 64 frames | Discard **oldest**, count it, do not error. |
| Emit, per peer | 256 frames | Close the session with `WT_PEER_TOO_SLOW`. |
| Call stream | 16 frames high-water | Apply backpressure to the producer. Never discard. |

The emit lane never discards. A lane that advertises reliable, ordered delivery and then
drops silently is a lie about the application's data; a peer 256 frames behind has already
failed, and disconnecting it is the honest outcome.

Call streams neither queue unboundedly nor discard. Because each call owns its own QUIC
stream, awaiting the writer applies flow control to that call's producer alone, so one slow
consumer cannot stall another call.

**Stale datagrams are a separate concern from overflow.** A queued datagram older than its
time-to-live is discarded **at dequeue**, default 150 ms. Overflow handles a burst; TTL
handles a stall. Without TTL, a peer that stalls for two seconds and resumes receives a
backlog of stale positions and renders history, which is worse than receiving nothing.

The two causes MUST be counted separately, as `overflowDropped` and `staleDropped`, so an
<!-- norm: drop-causes-counted-separately -> packages/core/src/datagram-lane.test.ts -->
operator can distinguish a slow network from a slow consumer.

---

## 10. Error codes

### 10.1 Stream reset codes

One byte. Sent as the QUIC application error code on `RESET_STREAM` or `STOP_SENDING`.

**A reset carries a code and nothing else, so it is used only where there is no stream
left to explain on.** Everything a responder can say about a *call* — the handler threw,
the event is not in the contract, the payload failed validation, the handshake had not
completed — is sent as a `CALL_ERROR` frame (§6.4) carrying both a code and a message, on
the stream the call already owns. That is strictly more than a reset can express, and it
is why this table is three rows rather than ten.

| code | name | meaning and remedy |
|---|---|---|
| `0` | `WT_NO_ERROR` | Normal termination. Implicit in a clean FIN; never sent explicitly. |
| `1` | `WT_ABORTED` | The initiator cancelled. Abandon the work; this is routine. |
| `9` | `WT_TOO_MANY_STREAMS` | Over 256 concurrent call streams on this session. The receiver resets the excess stream **without reading it**; the session stays open. Reduce concurrency and retry. |
| `2`–`8`, `10`–`255` | reserved | — |

### 10.2 Session close codes

`u32`, sent in the WebTransport session close. The accompanying reason string MUST NOT
<!-- norm: close-reason-1024-bytes -> packages/core/src/protocol-promises.test.ts -->
exceed **1024 bytes**, per the HTTP/3 WebTransport draft.

| code | name | meaning and remedy |
|---|---|---|
| `0` | `WT_NO_ERROR` | Normal close. |
| `1000` | `WT_PROTOCOL_VERSION_MISMATCH` | Peers disagree on `v`. Upgrade one side. |
| `1001` | `WT_CONTRACT_MISMATCH` | Fingerprints differ. Redeploy both sides together. |
| `1002` | `WT_HANDSHAKE_TIMEOUT` | No handshake within 5000 ms. |
| `1003` | `WT_PEER_TOO_SLOW` | Emit queue exceeded 256 frames. Consume faster. |
| `1004` | `WT_PROTOCOL_ERROR` | Unrecoverable framing violation. |
| `1006` | `WT_RELIABILITY_REFUSED` | Session was reliable-only. Not usable, see §2. |

### 10.3 Local codes

Raised by an implementation to its own application and never transmitted.

| name | meaning and remedy |
|---|---|
| `WT_NO_SUPPORT` | The runtime has no WebTransport. There is no fallback; the browser is unsupported. |
| `WT_DATAGRAM_TOO_LARGE` | Payload exceeded §7.4. Shorten it, or move the event to the stream lane. |
| `WT_ROOM_NOT_JOINED` | Broadcast to a room this session is not in. Join first. |
| `WT_SESSION_CLOSED` | The session closed while the operation was pending. Reconnect and retry. |

---

## 11. Session lifecycle

A session is established, handshakes (§4), carries traffic, and closes.

**Reconnection creates a new session.** Nothing is resumed: not the session identifier, not
room membership, not pending calls. Pending calls reject with `WT_SESSION_CLOSED`.
Re-establishing application state after a reconnect is the application's responsibility,
and the `session-resume` feature token (§4.2) is reserved for a future version that changes
this.

When a session closes, all its streams are closed and all pending calls reject. A peer that
detects its counterpart has gone MUST NOT attempt to reuse any stream from that session.
<!-- norm: session-streams-not-reused -> UNPROVEN: no test drives stream reuse after a peer-detected close; the transport rejects it, and asserting that asserts the transport -->
