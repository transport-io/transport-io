---
'transport-io': patch
---

Normative prose is gated. Every MUST in PROTOCOL.md and every bold guarantee in API.md now
carries an identifier naming a test that mentions it back, checked from both ends. Writing a
promise with no implementation now costs either a test or an explicit, counted admission —
three statements are recorded as unproven, one of which this found: nothing sends more than
one CALL_RESPONSE, so D7's multi-frame response shape is reserved and unexercised.
