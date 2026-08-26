---
'transport-io': patch
---

Teardown no longer leaks. A Session is disposed when its connection closes rather than only
when this side initiates the close, so the sweep interval — and the whole object graph its
callback retained — is released on every disconnect. An adapter rejection during teardown no
longer abandons the remaining rooms or surfaces as an unhandled rejection, and a rejected
join no longer leaves a peer receiving traffic for a room it was refused.
