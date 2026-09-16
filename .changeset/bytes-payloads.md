---
'transport-io': minor
---

`bytes()` declares a payload, a `returns` or a `yields` slot whose value is a `Uint8Array`
on both ends and bytes on the wire, under codec `0x02`, never base64 inside JSON. It fits any
helper beside a schema or a type in the other slots, on every lane and on the fallback. A
frame under the wrong codec for a slot is a protocol error naming the event and the slot.
