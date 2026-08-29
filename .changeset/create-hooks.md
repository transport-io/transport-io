---
'@transport-io/react': minor
---

`createHooks<AppMap>()` returns the hooks typed for one contract, so the React binding no
longer requires `declare module 'transport-io'`. That makes it consistent with the rest of the
library, where the map is passed explicitly: the type follows the import, and two contracts in
one process are two objects rather than a conflict over one global slot.

Measured: `api.useEvent` hovers at 129 characters against 123 for the registered form, and 116
destructured. Passing `MapOf<typeof contract>` in without the interface line takes it to 411.

`TransportProvider` is now generic over the map, because it previously accepted only a
registered client and would have rejected every client built the documented way.

`UseCallResult` and `UseStreamResult` take the map as their first type argument. The named
hook exports still read the registered map and are unchanged.
