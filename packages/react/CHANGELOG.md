# @transport-io/react

## 0.2.1

### Patch Changes

- Updated dependencies [0296766]
  - transport-io@0.7.0

## 0.2.0

### Minor Changes

- 4a48413: `createHooks<AppMap>()` returns the hooks typed for one contract, so the React binding no
  longer requires `declare module 'transport-io'`. That makes it consistent with the rest of the
  library, where the map is passed explicitly: the type follows the import, and two contracts in
  one process are two objects rather than a conflict over one global slot.
  
  Measured: `api.useEvent` hovers at 129 characters against 123 for the registered form, and 116
  destructured. Passing `MapOf<typeof contract>` in without the interface line takes it to 411.
  
  `TransportProvider` is now generic over the map, because it previously accepted only a
  registered client and would have rejected every client built the documented way.
  
  `UseCallResult` and `UseStreamResult` take the map as their first type argument. The named
  hook exports still read the registered map and are unchanged.

## 0.1.0

### Minor Changes

- d2f2c8f: The React binding: `TransportProvider`, `useClient`, `useConnection`, `useEvent`, `useCall`
  and `useStream`.
  
  All state comes through `useSyncExternalStore`, so `useConnection` returns a referentially
  stable object and reports `idle` during server rendering, which is both true and what makes
  the server's HTML match the client's first render. `useEvent` wraps the handler in an Effect
  Event, so an inline arrow re-created every render subscribes exactly once and no memoising is
  required. `useCall` and `useStream` report a discriminated union rather than independent
  flags, so checking `status` narrows `data` and the impossible states cannot be written.
  
  Unmounting cleans up: subscriptions unsubscribe, an in-flight call aborts unless you pass
  `{ abortOnUnmount: false }`, and a stream cancels, which resets the QUIC stream and runs the
  responder's `finally`.
  
  React 19.2 is the floor, because `useEvent` is built on `useEffectEvent`. There is no other
  runtime dependency.

### Patch Changes

- Updated dependencies [427d079]
  - transport-io@0.6.1
