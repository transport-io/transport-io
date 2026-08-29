---
'transport-io': patch
---

A `disconnect` arriving while `connect` is still awaiting the transport now abandons that
attempt. It used to be ignored: the session the superseded connect eventually produced was
adopted anyway and had every stored handler registered on it, so two sessions dispatched to
one handler and every event arrived twice.

React StrictMode performs exactly that sequence on each mount in development. The loopback
transport resolves too quickly for the window to open, so this was found in a real browser
over real QUIC by the new React binding's end-to-end test.

`disconnect` also disposes the session it closes, rather than only closing it, because closing
is not immediate on a real transport.
