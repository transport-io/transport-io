---
'transport-io': patch
---

Attribute the per-stream leak to both halves of the reference transport, measure the
alternative transport as flat, and fix connectHttp3 to await the native import so a
standalone Node client works.
