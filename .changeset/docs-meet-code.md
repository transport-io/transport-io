---
'transport-io': patch
---

Documentation reconciled with the implementation in both directions. Withdrawn: per-event
datagram TTL and `ttl: null`, which `EventDef` never grew and `DatagramQueue` could not
accept; and the instruction to gate session establishment behind authentication, in a library
that exposes no peer identity and has no reject hook. Corrected: the event id width in the
decision ledger and ADR 0010 still said two bytes against a four-byte wire, and §7.3 argued
for a hashed Origin eighty lines after establishing that Origin is allocated.
