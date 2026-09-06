---
'transport-io': patch
---

The reference binding moves to `@fails-components/webtransport` 1.6.8, which fixes the
per-stream memory retention that every `call()` and `stream()` paid for on the server
(fails-components/webtransport#511). The bench that found it now measures flat over 16,000
streams where 1.6.7 retained about 11.6 KB each. The limitation is gone from the
documentation, and the `call()` lane rejoins the memory-soak criterion.
