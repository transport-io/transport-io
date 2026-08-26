---
'transport-io': patch
---

The lane soak no longer passes on an empty sample set. A run shorter than its own warmup
collected no samples, and with none the fitted slope was 0 and the peak RSS was `-Infinity` —
both inside their bounds — so it printed `SOAK PASSED` having measured nothing. It now
requires at least three samples and says so when it does not have them.
