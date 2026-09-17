---
title: Devtools
description: See the frames, the streams and the drops, which no browser panel shows for WebTransport, and log them with the same seam the panel uses.
---

Chrome's network panel shows nothing useful for a WebTransport session: no frames, no
streams. `@transport-io/devtools` is a panel in the page that shows both, and the drops that
`stats()` counts, by event.

```bash
npm install @transport-io/devtools
```

## Mount it

You mount it; nothing loads it for you, in any environment.

```ts file=contract.ts
import { defineContract, type MapOf, reliable, unreliable } from 'transport-io'

export const contract = defineContract({
  chat: reliable<{ from: string; body: string }>(),
  cursor: unreliable<{ x: number; y: number }>(),
})

export interface AppMap extends MapOf<typeof contract> {}
```

```ts file=main.ts
import { mountPanel } from '@transport-io/devtools'
import { Client } from 'transport-io'
import { connectDev } from 'transport-io/dev-transport'
import { type AppMap, contract } from './contract.ts'

export const client = new Client<AppMap>({ contract, connect: () => connectDev() })

// on your own machine only
if (['localhost', '127.0.0.1'].includes(location.hostname)) mountPanel(client)

await client.connect()
```

`mountPanel(client, options?)` puts a launcher in the corner of the page and returns the
unmount. It reads no environment, so whether a build gets a panel is the line you wrote.
Mount it before `connect()` and the handshake is the first thing it shows.

In React it is a component, anywhere in the tree:

```tsx file=tools.tsx
import { TransportDevtools } from '@transport-io/devtools/react'
import type { Client } from 'transport-io'
import type { AppMap } from './contract.ts'

export function Tools({ client }: { client: Client<AppMap> }) {
  return <TransportDevtools client={client} />
}
```

It renders `null` unless the build's `process.env.NODE_ENV` is `development`, and a
production bundle contains none of the panel's code. It takes the client as a prop.

`open: true` starts it open, `preview: true` shows the first 256 bytes of each payload,
`capacity` is how many records it keeps, 1,000 unless given, and `visibleRows` is how many
the list shows, 200 unless given.

## What it shows

**Frames**, in and out: time, direction, lane, kind, event, stream, size, and a datagram's
sequence number. Stream 0 is the emit stream; each `call()` and `stream()` takes the next
number. A divider marks each new session, since a reconnect is one.

**Open streams**: every call and stream in flight, with the frames and bytes that have
crossed it.

**The connection**: status, transport, and why a session is on the fallback.

**Drops**: the counters from `stats()`, and beside them which event each drop was. A dropped
message is its own row, marked, after the row for the frame it discarded.

**Pause** stops keeping records, so the rows you are reading are not overwritten, and counts
what it skipped. **Filter** by event or by lane. **Copy rows** puts the visible rows on the
clipboard as text, under two lines that say what they were taken from. That text is what to
paste into an issue.

## Without the panel

The panel reads one method, and a logger can read the same one. `client.observe()` calls you
with a record for every frame, every call stream opening and closing, and every drop:

```ts file=log-drops.ts
import type { Client } from 'transport-io'
import type { AppMap } from './contract.ts'

export function logDrops(client: Client<AppMap>): () => void {
  return client.observe((record) => {
    if (record.kind.endsWith('-dropped') || record.kind === 'stale-received') {
      console.warn(`${record.kind}: ${record.event} #${record.sequence}`)
    }
  })
}
```

A client nobody observes builds no records. A record holds no payload; `{ preview: true }`
adds the start of each one as a string, to the subscriber that asked and nobody else. The
fields are in [the API reference](https://github.com/transport-io/transport-io/blob/main/API.md).

## What will bite you

**These are this client's drops.** The network's loss is not visible from here, and neither is
what the server dropped on its way to this client, which is `peer.stats()` on the server.

**A gap in the sequence numbers is not loss.** The server numbers an event across every room,
so a gap can be a broadcast this client was not part of.

**The panel records from when it mounts.** The counters come from `stats()` and cover the
whole session either way.

**Previews are payloads.** `preview: true` puts the start of each message on screen and in
anything you copy.

**An observer runs inside the session, once per frame.** Do one cheap thing in it: append to
a bounded list, bump a counter. Never keep `JSON.stringify(payload).slice(0, 256)` from a
handler as a preview of your own: a sliced string keeps the whole payload alive.
