---
title: Registering the map
description: Register the map once and drop the type argument everywhere, at the cost of one slot per process.
---

`AppMap` is passed once at each end, `createServer<AppMap>` and `browserClient<AppMap>`, and
is never inferred from `contract`. An application that builds clients or servers in many
files can register the map once instead, and then drop the type argument everywhere:

```ts standalone
import { Client, defineContract, type MapOf, reliable } from 'transport-io'

export const contract = defineContract({ chat: reliable<{ body: string }>() })
export interface AppMap extends MapOf<typeof contract> {}

declare module 'transport-io' {
  interface Register {
    map: AppMap
  }
}

// `Client` and `Server` now default to AppMap, with no type argument anywhere.
declare const client: Client
client.emit('chat', { body: 'hi' })
```

**The tradeoff.** It is a global augmentation, so there is one slot per process: two contracts
in the same process conflict, and the type a file sees depends on which module was loaded
rather than on what that file imported. It changes no hover; it removes the type argument and
nothing else.

Leave the map unregistered and leave the type argument off, and you get the sentinel telling
you to register a map or pass one.

`@transport-io/react` does not need it: `createHooks<AppMap>()` binds the hooks to a map the
same way everything else takes one. Its named exports, `useEvent`, `useCall` and the rest,
read the registered map instead.
