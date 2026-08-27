---
'transport-io': patch
---

Documentation correction: `emit` hover is 107 characters with the two-line contract pattern
and 353 without it, for the README's contract. The previously published numbers, 126 and 303,
were wrong and nothing measured them. `scripts/check-hover.ts` now drives `tsc --lsp --stdio`
and measures the real hover string on every CI run. See D94.
