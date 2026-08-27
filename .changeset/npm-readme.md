---
'transport-io': patch
---

The package README now mentions `stream()`, and states the upstream 5.95 KB leak as per
bidirectional stream rather than per `call()` - so a reader can see that a thousand streamed
tokens cost what one call does, instead of concluding that every request leaks.
