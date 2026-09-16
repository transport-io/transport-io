---
'@transport-io/react': minor
---

`useCall`'s function resolves to the answer, the way TanStack Query's `mutateAsync` does,
and rejects with the `TransportError` on failure, with `WT_ABORTED` when superseded or
unmounted, and with `WT_LANE_UNAVAILABLE` on a fallback session; a caller that ignores the
promise reads the failure from the state and sees no unhandled rejection.
`createHooks<M>({ fallback: false })` says the application has no fallback, so `useClient()`
is the `Client` with `call` and `stream` on it and `useNative()` is the same client; a
fallback client mounted under those hooks throws on first use.
