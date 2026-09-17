---
title: React
description: Hooks over useSyncExternalStore, correct under StrictMode, SSR and the App Router.
---

`@transport-io/react` is the binding. It is a separate package with its own version, and no
core code depends on it or refers to it.

```bash
npm install @transport-io/react
```

React and react-dom are peer dependencies, and the floor is **React 19.2**, because
`useEvent` is built on `useEffectEvent`. There is no runtime dependency beyond that.

The complete app is
[`examples/react`](https://github.com/transport-io/transport-io/tree/main/examples/react):
chat with live cursors on these hooks, under Vite, with nothing else in the way.

## Bind the hooks to your map

`createHooks<AppMap>()` returns the hooks typed for one contract. That is the whole setup.

```ts file=api.ts
import { defineContract, type MapOf, reliable, rpc, streaming } from 'transport-io'
import { createHooks } from '@transport-io/react'

export const contract = defineContract({
  chat: reliable<{ from: string; body: string }>(),
  save: rpc<{ text: string }, { n: number }>(),
  ask: streaming<{ prompt: string }, string>(),
})
export interface AppMap extends MapOf<typeof contract> {}

export const api = createHooks<AppMap>()
```

Then `api.useEvent('chat', …)` anywhere, or destructure it:
`export const { useEvent, useCall } = createHooks<AppMap>()`.

Write the `MapOf` line. Without it, every hook's hover shows the whole contract with your
validator's internals in it.

The named exports (`useEvent`, `useCall`, …) read the globally registered map instead; see
[Registering the map](/guides/register/).

An application with no fallback says so, and `useClient()` is then the `Client`, with `call`
and `stream` on it, instead of a union that has to be narrowed through `useNative()`:

```ts
import { createHooks } from '@transport-io/react'
import type { AppMap } from './api.ts'

export const native = createHooks<AppMap>({ fallback: false })
```

It is checked: a client built with `withFallback` under these hooks throws on first use.

## The provider takes a client

It does not make one. **A module-level client is a cross-request state leak** on anything
rendering more than one user, so build it inside the component.

```tsx
'use client'
import { Client } from 'transport-io'
import { connectBrowser } from 'transport-io/browser-transport'
import { TransportProvider } from '@transport-io/react'
import { type ReactNode, useState } from 'react'
import { type AppMap, contract } from './api.ts'

export function Providers({ children }: { children: ReactNode }): ReactNode {
  // `useState` with an initialiser, so one client per mounted tree rather than one per
  // render, and never one shared between server requests.
  const [client] = useState(
    () =>
      new Client<AppMap>({
        contract,
        connect: () => connectBrowser({ url: 'https://127.0.0.1:4433/' }),
      }),
  )
  return <TransportProvider client={client}>{children}</TransportProvider>
}
```

`new Client` here rather than `browserClient`: `TransportProvider` wants the client *before*
it is connected, since it does the connecting itself in an effect, so the client has to exist
synchronously inside the `useState` initialiser.

`TransportProvider` connects while it is mounted. Pass `autoConnect={false}` to drive the
connection yourself. `connect` and `disconnect` are refcounted in core, so two providers or a
StrictMode double mount cannot tear down each other's session.

**Your `connect` function must be able to produce a new connection each time it is called.**
A reconnect is a new session, and StrictMode calls it twice in development. `connectBrowser`
already does this; a hand-rolled one that returns a single fixed connection will hang on the
second call.

A client built with `withFallback` fits the provider as well. On a fallback session, which
carries emits and nothing else, `useCall` and `useStream` report `unavailable` before anything
is asked, `useNative()` is `null`, and `useConnection().transport` is `'websocket'`. Nothing
is discovered by calling: the call's promise rejects with `WT_LANE_UNAVAILABLE` and asks the
server nothing.

## Connection state

```tsx
import type { ReactNode } from 'react'
import { api } from './api.ts'

export function Status(): ReactNode {
  const { status, rooms, lastError, refused } = api.useConnection()
  // Refused by the server's authorize. Final: nothing is retrying, so ask for a sign-in.
  if (refused !== null) return <p>sign in again ({refused.reason})</p>
  if (status === 'closed' && lastError !== null) return <p>offline: {lastError.code}</p>
  return (
    <p>
      {status}, in {rooms.length} room(s)
    </p>
  )
}
```

All state comes through `useSyncExternalStore`, and the object this returns is referentially
stable: it changes only when the connection state does, so putting it in a dependency array
is safe. `transport` and `fallbackReason` are on the same object: what carries the session,
and why it is a fallback when it is. [The fallback](/guides/fallback/) covers the rest.
`refused` is there too: `{ reason }` when the server's `authorize` refused this client, and
`null` otherwise. [Authenticating a peer](/guides/authorize/) has the reasons and the way
back in.

**During server rendering it reports `idle`.** That is true, since no connection exists on a
server, and it makes the server's HTML identical to the client's first render, so hydration
has nothing to reconcile. The connect effect then drives the only transition.

## Events

```tsx
import { type ReactNode, useState } from 'react'
import { api } from './api.ts'

export function Messages(): ReactNode {
  const [lines, setLines] = useState<string[]>([])

  // A fresh arrow every render, and the subscription still happens once.
  api.useEvent('chat', (msg) => {
    setLines((prev) => [...prev, `${msg.from}: ${msg.body}`])
  })

  return <ul>{lines.map((l) => <li key={l}>{l}</li>)}</ul>
}
```

You do not have to memoise the handler. `useEvent` wraps it in an Effect Event, so the
subscription depends only on the client and the event name while the handler always sees the
latest render's closure. Unsubscribing is wired to effect cleanup.

Handlers attach to the client, not to a session. A component mounted before the connection
opens receives everything from the first session, and from every session a reconnect
produces, without doing anything about it.

## Calls

State is a discriminated union rather than independent flags, so checking `status` narrows
`data` and the impossible combinations cannot be written down.

```tsx
import type { ReactNode } from 'react'
import { api } from './api.ts'

export function Save(): ReactNode {
  const [save, state] = api.useCall('save')

  return (
    <>
      <button type="button" onClick={() => void save({ text: 'hello' })}>
        Save
      </button>
      {state.status === 'pending' && <span>saving…</span>}
      {state.status === 'error' && <span>{state.error.code}</span>}
      {state.status === 'success' && <span>{state.data.n} characters</span>}
      {state.status === 'unavailable' && <span>not on this connection</span>}
    </>
  )
}
```

The function resolves to the answer as well, so a handler that wants the value right away
has it without reading the state:

```tsx
import { api } from './api.ts'

export function useSaveAndTell(): (text: string) => Promise<string> {
  const [save] = api.useCall('save')
  return async (text) => {
    const { n } = await save({ text })
    return `${n} characters`
  }
}
```

It rejects with the `TransportError` on failure, with `WT_ABORTED` when a newer call
superseded it or the component unmounted, and with `WT_LANE_UNAVAILABLE` on a fallback
session. A caller that ignores the promise, as the button above does, reads the failure from
`state` and never sees an unhandled rejection.

`unavailable` is the state on a fallback session, where there is no stream to carry a call.
It is there before the button is pressed, and pressing it asks the server nothing.

**Unmounting aborts an in-flight call.** An unmounted component's answer goes nowhere, and
aborting is a QUIC stream reset that costs no application message. That bites when the call
has a server-side effect that must finish regardless, so pass
`api.useCall('save', { abortOnUnmount: false })` for those.

## Streams

```tsx
import type { ReactNode } from 'react'
import { api } from './api.ts'

export function Ask(): ReactNode {
  const [ask, state, stop] = api.useStream('ask')

  return (
    <>
      <button type="button" onClick={() => ask({ prompt: 'hello' })}>
        Ask
      </button>
      {state.status === 'streaming' && (
        <button type="button" onClick={stop}>
          Stop
        </button>
      )}
      {state.status === 'unavailable' && <span>not on this connection</span>}
      {state.status !== 'idle' && <p>{state.elements.join('')}</p>}
    </>
  )
}
```

`elements` keeps its identity between renders and is replaced only when something is
appended, so memoising on it works. It also grows for the life of the stream: pass
`{ onElement }` to render without accumulating.

**Unmounting cancels, and so does `stop`.** Either resets the QUIC stream, the responder sees
STOP_SENDING, its `ctx.signal` fires and any `finally` in its generator runs, so a component
going away does not leave a generator producing into nothing. After `stop` the state is
`done`, holding what had arrived.

## Server components

Every hook is a client-side thing and the entry carries `'use client'`. A server component
that calls one gets React's own error saying hooks are not available there. A hook used
outside the provider throws an error naming
`TransportProvider` rather than reading a property of `undefined`.

## StrictMode

Development mounts every component twice. Refcounting makes that safe, and it is worth
knowing what it actually does: the refcount goes 1, 0, 1, and at zero the session genuinely
tears down and is rebuilt. One wasted connection cycle, in development only.

