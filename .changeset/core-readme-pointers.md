---
'transport-io': patch
---

The package README points to `@transport-io/devtools` and to the deploying guide, and says
the fourteen-day ECDSA rule is for a pinned certificate, where it said a pinned development
one: a deployed server is often pinned too. The README ships in the package, so this is what
puts it on npm. `ConnectRequest`'s documentation says `authorize` is handed the request's
headers on both listeners, and that a browser puts `origin` there.
