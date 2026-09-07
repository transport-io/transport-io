---
'@transport-io/react': minor
---

`TransportProvider` accepts a client built with `withFallback`, and `useClient()` returns
`Client | FallbackClient`, so `call` and `stream` are reached through the new `useNative()`,
which is the client on a native session and `null` on a fallback one. `useCall` and
`useStream` report `unavailable` on a fallback session before anything is asked, and asking
does nothing there.
