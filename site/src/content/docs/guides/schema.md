---
title: Types, or a schema
description: Describe a payload with a type and pay nothing at runtime, or with a Standard Schema and have every inbound message validated.
---

`reliable<T>()` describes the payload with a type. Nothing validates it at runtime, and it
costs nothing at runtime either. A peer that sends the wrong shape is caught by whatever the
handler does with it, which may be nothing.

```ts
// contract.ts
import { defineContract, type MapOf, reliable, unreliable } from 'transport-io'

export const contract = defineContract({
  chat: reliable<{ from: string; body: string }>(),
  cursor: unreliable<{ x: number; y: number }>(),
})

export interface AppMap extends MapOf<typeof contract> {}
```

Pass a Standard Schema instead, and inbound payloads are validated on arrival:

```ts standalone
// contract.ts, with runtime validation
import { defineContract, type MapOf, reliable, unreliable } from 'transport-io'
import { z } from 'zod'

export const contract = defineContract({
  chat: reliable(z.object({ from: z.string(), body: z.string().max(2000) })),
  cursor: unreliable(z.object({ x: z.number(), y: z.number() })),
})

export interface AppMap extends MapOf<typeof contract> {}
```

The payload types are inferred either way, so the rest of your application is identical.

| | `reliable<T>()` | a schema |
|---|---|---|
| inbound validation | none | every message, on arrival |
| runtime cost | zero | one check per message |
| bad payload from a peer | reaches your handler | rejected with `WT_VALIDATION_FAILED` |
| dependency | none | your validator |

Use a schema wherever a peer you do not control can reach, which for a server is every
client. Use types where both ends are yours and the traffic is high, such as cursor
positions at pointer rate.

Any [Standard Schema](https://standardschema.dev) validator works: zod, valibot, arktype.
The library depends on none of them. `examples/react` defines its contract with zod.
