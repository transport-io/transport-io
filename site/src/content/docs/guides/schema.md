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

## Bytes

A payload that is already bytes stays bytes. `bytes()` declares a slot whose value is a
`Uint8Array` on both ends and travels on the wire as it is, under its own codec, never
base64 inside JSON. A Yjs update, an image chunk, a compressed blob:

```ts standalone
import { bytes, defineContract, type MapOf, reliable, rpc, streaming } from 'transport-io'
import { z } from 'zod'

export const contract = defineContract({
  update: reliable(bytes()),
  snapshot: rpc(z.object({ since: z.number() }), bytes()),
  chunks: streaming(bytes(), bytes()),
})

export interface AppMap extends MapOf<typeof contract> {}
```

It fits any slot of any helper, beside a schema or a type in the others. A payload is JSON
or bytes, never a mix: bytes inside an object are still JSON. Sending anything but a
`Uint8Array` to a bytes slot fails before the wire with `WT_VALIDATION_FAILED`, and what a
handler receives is a copy it owns. The size caps are the frame's, as for any payload.
