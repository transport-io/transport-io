---
'transport-io': patch
---

The published tarball no longer ships the benchmarks. `dist/bench/*` — including a moq
deadlock reproduction that imports a package consumers do not have — was 16 of 115 files.
