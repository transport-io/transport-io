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

It fits any slot of any helper, beside a schema or a type in the others. Sending anything
but a `Uint8Array` to a bytes slot fails before the wire with `WT_VALIDATION_FAILED`, and what
a handler receives is a copy it owns. The size caps are the frame's, as for any payload.

**A slot is all bytes or all JSON.** There is no object with a `Uint8Array` field in it: put
one in a JSON payload and it is serialised as JSON, index by index. A call has two slots and
they may differ, which covers a request that describes and a response that carries,
`snapshot` above. An emit has one slot, so a message that needs both halves is two events:
the JSON half first, then the bytes.

```ts standalone
import { bytes, type Client, defineContract, type MapOf, reliable, type Server } from 'transport-io'
import { z } from 'zod'

export const contract = defineContract({
  updateFor: reliable(z.object({ doc: z.string(), by: z.string() })),
  update: reliable(bytes()),
})

export interface AppMap extends MapOf<typeof contract> {}

export function send(client: Client<AppMap>, doc: string, by: string, update: Uint8Array): void {
  client.emit('updateFor', { doc, by })
  client.emit('update', update)
}

declare function apply(doc: string, by: string, update: Uint8Array): void

export function receive(server: Server<AppMap>): void {
  server.onSession((peer) => {
    let next: { doc: string; by: string } | undefined
    peer.on('updateFor', (header) => {
      next = header
    })
    peer.on('update', (update) => {
      if (next !== undefined) apply(next.doc, next.by, update)
    })
  })
}
```

Both events are on the reliable lane, which delivers one sender's emits in the order they
were made, so the header a handler holds is the one its bytes came with. When the JSON half
never changes, a document id, make it the room and send only the bytes.
