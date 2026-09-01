---
'transport-io': minor
---

Each transport module now exports a construct-and-connect form that resolves to a connected
client: `browserClient` from `transport-io/browser-transport`, `devClient` from
`transport-io/dev-transport`, and `http3Client` from `transport-io/node-transport`. Each takes
every `ClientOptions` field except `connect`, plus its own transport's options.

```ts
const client = await browserClient<AppMap>({ contract, url })
```

The map is a type argument and is deliberately not inferred from `contract`. Inferring it
would resolve to `Client<MapOf<typeof contract>>`, whose `emit` hover is 377 characters
against 107 for a named interface, so the shorter spelling would be the worse one. Omitting it
falls to `Registered`, which either works because the application registered a map or fails
with the sentinel naming the fix.

`new Client({ contract, connect })` is unchanged and is not deprecated. The one-call form
hands back a client that is already connected, so anything needing the client before then
still constructs it: a transport of your own, React, where `TransportProvider` takes an
unconnected client and connects it in an effect, and any page rendering `connecting`.

**Breaking:** `Http3ClientOptions` is renamed `Http3ConnectOptions`, so all three transport
modules name their connection options alike and `Http3ClientOptions` can mean what the other
two mean. `connectHttp3` is otherwise unchanged.
