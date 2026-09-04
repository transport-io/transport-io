# @transport-io/react

React bindings for [transport-io](https://www.npmjs.com/package/transport-io).

```bash
npm install @transport-io/react
```

React and react-dom are peer dependencies and the floor is **React 19.2**, because `useEvent`
is built on `useEffectEvent`. There is no other runtime dependency, and no core code depends
on this package or refers to it.

## Bind the hooks to your map

```ts
import { defineContract, type MapOf, reliable } from 'transport-io'
import { createHooks } from '@transport-io/react'

export const contract = defineContract({ chat: reliable<{ body: string }>() })
export interface AppMap extends MapOf<typeof contract> {}

export const api = createHooks<AppMap>()
```

Then `api.useEvent('chat', …)`, or destructure it. Nothing is registered globally, so two
contracts in one process are two objects, and the type follows the import.

Write the `MapOf` line. Without it, every hook's hover shows the whole contract with your
validator's internals in it.

The named exports below read the globally registered map instead.

## What it gives you

| | |
|---|---|
| `createHooks<AppMap>()` | The hooks, typed for one contract. The documented default. |
| `<TransportProvider client>` | Holds the client and connects while mounted. Takes a client rather than making one. |
| `useClient()` | The client itself, for `emit` and anything else. |
| `useConnection()` | Status, session id, rooms, last error, and the connect and disconnect calls. |
| `useEvent(name, handler)` | Subscribe for as long as the component is mounted. No memoising required. |
| `useCall(name)` | Request and response, as a discriminated union. |
| `useStream(name)` | A streaming response, accumulated. `stop` ends it as `done`; unmount cancels. |

There is deliberately no `useEmit` and no `useRooms`. `emit` is one synchronous method with
no state and no cleanup, so `useClient().emit(…)` is already the right call. `useRooms` would
read one field off a snapshot while re-rendering on every change to any of it, which looks
like a narrow subscription and is not one; `useConnection().rooms` is the same thing without
the false promise.

## The parts that are easy to get wrong

**All state comes through `useSyncExternalStore`.** `useConnection` returns a referentially
stable object, so it is safe in a dependency array.

**Handlers do not need memoising.** `useEvent` wraps yours in an Effect Event, so an inline
arrow re-created every render subscribes exactly once.

**Server rendering reports `idle`**, which is both true and what makes the server's HTML match
the client's first render.

**Unmounting cleans up.** Subscriptions unsubscribe, an in-flight call aborts unless you pass
`{ abortOnUnmount: false }`, and a stream cancels, which resets the QUIC stream and runs the
responder's `finally`.

**Your `connect` function must return a new connection each call.** A reconnect is a new
session and StrictMode calls it twice in development.

The [React guide](https://transport-io.github.io/transport-io/guides/react/) has the whole
thing with code.

## Licence

MIT
