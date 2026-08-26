---
'transport-io': patch
---

Depend on moq's per-platform native packages rather than a file path, root-cause its
server-close deadlock, and record the decision to stay on the reference transport with the
per-stream leak documented.
