---
'@transport-io/react': minor
---

The React binding: `TransportProvider`, `useClient`, `useConnection`, `useEvent`, `useCall`
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
