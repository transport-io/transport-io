---
'transport-io': patch
---

Fix ctx.signal never firing on the responder when a caller aborts. Add a moq transport
behind the seam and a per-transport parity suite; record why moq is not yet adoptable.
