---
'transport-io': minor
---

`listen()` takes an optional connection source and owns the accept loop:

```ts
const listener = await listenHttp3({ port: 8080, host: '127.0.0.1', cert, privKey, path: '/' })
await server.listen(listener)
```

That loop was previously written by every application, identically, and every copy swallowed
the rejection. A failed accept is now counted in `server.acceptErrors` and reported to
`onAcceptError` if one is given. One refused handshake does not stop the loop.

`listen()` with no argument still prepares the server and leaves `accept()` to you, which is
what you want when a connection has to be inspected before it is accepted.
