---
'transport-io': minor
---

Add README, AGENTS.md and CHANGELOG. Run the memory soak: it fails on an unbounded
upstream leak of 11.6 KB per bidirectional stream, which blocks Stage 1.
