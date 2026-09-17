# @transport-io/devtools

A devtools panel for [transport-io](https://www.npmjs.com/package/transport-io). Chrome's
network panel shows nothing useful for WebTransport: no frames, no streams. This shows both,
in the page, along with the one thing no other tool has: which messages this client dropped,
and why.

```bash
npm install @transport-io/devtools
```

It needs `transport-io` 0.13 or later.

## Mount it

You mount it; nothing loads it for you.

```ts
import { mountPanel } from '@transport-io/devtools'
import { Client, defineContract, type MapOf, reliable } from 'transport-io'
import { connectDev } from 'transport-io/dev-transport'

const contract = defineContract({ chat: reliable<{ body: string }>() })
interface AppMap extends MapOf<typeof contract> {}

const client = new Client<AppMap>({ contract, connect: () => connectDev() })

// on your own machine only
if (['localhost', '127.0.0.1'].includes(location.hostname)) mountPanel(client)
```

`mountPanel(client, options?)` adds a launcher to the corner of the page and returns the
unmount. It reads no environment, so whether a build gets a panel is the line you wrote. To
keep its code out of a production bundle altogether, import it dynamically behind your own
condition.

In React, put the component anywhere in the tree:

```tsx
import { TransportDevtools } from '@transport-io/devtools/react'
import type { Client } from 'transport-io'
import type { ReactNode } from 'react'

export function Tools({ client }: { client: Client }): ReactNode {
  return <TransportDevtools client={client} />
}
```

It renders `null` unless the build's `process.env.NODE_ENV` is `development`, and a
production bundle contains none of the panel. It takes the client as a prop, so it needs
nothing from `@transport-io/react`.

| Option | |
| --- | --- |
| `open` | Start open. Closed unless given: a launcher, and nothing painted. |
| `preview` | Show the first 256 bytes of each payload. Off unless given. |
| `capacity` | How many records are kept. 1,000 unless given. |
| `visibleRows` | How many rows the list shows. 200 unless given. |
| `target` | Where the panel is appended. `document.body` unless given. |

## What it costs

Closed, nothing that can be measured. Open, between 1 and 34 ms of main-thread time a second,
3% of it at worst, with no dropped frame: measured on the chat example with two clients and
both pointers driven at 60 to 280 events a second, in headless Chromium. Leave it mounted, and
close it before you profile your own page. A closed panel still records, so opening it shows
what already happened.

## What it shows

- **Frames.** Every frame in and out: time, direction, lane, kind, event, stream, size, and a
  datagram's sequence number. A divider marks each new session, since a reconnect is one.
- **Open streams.** Each `call()` and `stream()` in flight, with the frames and bytes that
  have crossed it.
- **The connection.** Status, transport, and why a session is on the fallback.
- **Drops.** The counters from `client.stats()`, and beside them which event each drop was.
  A dropped message is its own row, in the accent colour, after the row for the frame it
  discarded.

| In the bar | What happened |
| --- | --- |
| `queue` | Datagrams waiting to be sent right now. Not a drop. |
| `overflow` | You emitted faster than datagrams leave: the queue holds 64, and the oldest was pushed out. |
| `stale` | A datagram waited 150 ms in the queue and was discarded unsent. |
| `stale rx` | A duplicate or out-of-order datagram arrived and was not handed to your handler. |
| `direction` | The server sent an event the contract says only a client sends. |

A dim row is on the unreliable lane. The
[guide](https://transport-io.github.io/transport-io/guides/devtools/) has every column and
every `kind`.

**Pause** stops keeping records, so the rows you are reading are not overwritten, and counts
what it skipped. **Filter** by event or by lane. **Copy rows** puts the visible rows on the
clipboard as text, under two lines that say what they were taken from, which is what to paste
into an issue.

## What will bite you

- **These are this client's drops.** The network's loss is not visible from here, and neither
  is what the server dropped on its way to this client; that is `peer.stats()` on the server.
- **A gap in `seq` is not loss.** The server numbers an event across every room, so a gap can
  be a broadcast this client was not part of.
- **The panel starts recording when it mounts.** Mount it before `connect()` to see the
  handshake. The counters come from `stats()` and cover the whole session either way.
- **Previews are payloads.** `preview: true` puts the start of each message on screen and in
  anything you copy. Leave it off where that matters.
- **Without React or a bundler**, use `mountPanel`. The React entry reads
  `process.env.NODE_ENV` the way `react` itself does, which a bundler replaces and a bare
  browser does not define.

The store behind the panel is exported too, `createStore(client)`, with `subscribe` and
`getSnapshot`, for a panel of your own. The
[devtools guide](https://transport-io.github.io/transport-io/guides/devtools/) has the rest.
