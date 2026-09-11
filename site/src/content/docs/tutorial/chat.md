---
title: A chat with cursors
description: From an empty directory to a working chat with live cursors, one file at a time, ending at examples/chat.
---

You start with nothing and end with a chat that works in two browser windows: messages that
always arrive, cursors that follow the pointer and are allowed to drop, a name assigned by a
call, a reply that streams in a word at a time, and a slider that makes the unreliable lane
visibly lose frames. Every file is complete when you see it. Nothing is used before the step
that builds it. The eight files you write are the eight in `examples/chat` in the repository,
byte for byte, and a check in that repository fails if this page and that example ever
disagree.

You need Node 22 or newer, Chrome or Firefox, and a bundler for the browser page. The steps
use `bun build`, one line and no configuration; `esbuild` does the same with the flags shown
at the step that first needs it.

## 1. An empty directory

```bash
mkdir chat && cd chat
npm init -y
npm install transport-io
npm install @fails-components/webtransport-transport-http3-quiche
npm install -D typescript @types/node
```

The second install is the native QUIC transport. It is not a dependency of `transport-io`,
only something the server loads at runtime, so it has to be installed by name. Browsers need
nothing extra.

Replace the generated `package.json` with this one:

```json file=package.json
{
  "name": "chat",
  "private": true,
  "type": "module",
  "scripts": {
    "build:web": "bun build web/main.ts --outdir web/dist --target browser",
    "dev": "bun run build:web && transport-io dev server.node.ts --static web"
  }
}
```

And add a `tsconfig.json`:

```json file=tsconfig.json
{
  "compilerOptions": {
    "strict": true,
    "noEmit": true,
    "module": "nodenext",
    "moduleResolution": "nodenext",
    "target": "es2023",
    "lib": ["es2023", "dom", "dom.iterable"],
    "types": ["node"],
    "allowImportingTsExtensions": true,
    "rewriteRelativeImportExtensions": true,
    "skipLibCheck": true
  },
  "include": ["**/*.ts"]
}
```

`allowImportingTsExtensions` matters: every import in this project names its file with the
`.ts` on, which is what Node runs directly and what the bundler resolves.

## 2. The contract

One file says what every event is and whether it can be dropped. Both the server and the page
import it, and neither can send an event it does not name.

```ts file=contract.ts
import { defineContract, type MapOf, reliable, unreliable } from 'transport-io'

export const contract = defineContract({
  chat: reliable<{ from: string; body: string; at: number }>(),
  cursor: unreliable<{ from: string; x: number; y: number }>(),
})

export interface ChatMap extends MapOf<typeof contract> {}
```

`chat` is `reliable`: it arrives, in order, or the session fails. `cursor` is `unreliable`:
it may be dropped, duplicated or reordered, and that is right for a cursor, because the next
position makes the last one worthless. The lane is declared here and nowhere else.

`ChatMap` is the second line, and it is the one to pass to a client or a server. Without it,
every hover shows the whole contract with your validator's internals in it.

## 3. The server

The handlers in one file, the server in another. The handlers are a function that takes a
server, so a second server file, a deployed one, can attach the same ones later.

```ts file=app.ts
/** The handlers, attached to whichever server hosts the contract. */
import type { Server } from 'transport-io'
import type { ChatMap } from './contract.ts'

export interface AttachOptions {
  room?: string
  log?: (line: string) => void
}

export function attach(server: Server<ChatMap>, opts: AttachOptions = {}) {
  const room = opts.room ?? 'lobby'
  const log = opts.log ?? console.log

  const online = new Set<string>()

  server.onSession((peer) => {
    void peer.join(room)
    online.add(peer.id)
    log(`+ ${peer.id} joined (${online.size} online)`)

    peer.on('chat', (msg) => {
      // To everyone, the sender included.
      void server.to(room).emit('chat', { ...msg, at: Date.now() })
    })

    peer.on('cursor', (pos) => {
      void server.to(room).except(peer.id).emit('cursor', pos)
    })
  })
}
```

Rooms are server-authoritative: a client cannot join by sending anything, so `peer.join` is
called here when a session arrives. `chat` goes to everyone in the room, the sender included,
with the time stamped on the server. `cursor` goes to everyone except the sender, because the
sender already knows where its own pointer is.

```ts file=server.node.ts
/** The local server. `npx transport-io dev server.node.ts` runs it and serves `web/`. */
import { createServer } from 'transport-io'
import { listenDev } from 'transport-io/node-transport'
import { attach } from './app.ts'
import { type ChatMap, contract } from './contract.ts'

const server = createServer<ChatMap>({ contract })
attach(server)

await server.listen(await listenDev(), {
  onAcceptError: (e) => console.error('session refused:', (e as Error).message),
})
```

`listenDev()` reads the certificate that `transport-io dev` mints and passes in by
environment. The file is named `.node.ts` because it loads the native transport, which only
Node can run.

## 4. Run it

```bash
npx transport-io dev server.node.ts
```

It prints the page URL, the WebTransport URL and the certificate's fingerprint, and says it
found no static directory, because there is no page yet. The server is up. The next step
gives it a page.

## 5. The page

Two files in `web/`. The command serves that directory, so `web/index.html` is the page at
`/` and the bundle it loads goes to `web/dist/`.

```html file=web/index.html
<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<title>transport-io - chat with live cursors</title>
<style>
  :root { color-scheme: light dark; --bg:#fff; --fg:#111; --dim:#666; --line:#e5e5e5; --accent:#2563eb; }
  @media (prefers-color-scheme: dark) { :root { --bg:#111; --fg:#eee; --dim:#999; --line:#2a2a2a; } }
  * { box-sizing: border-box; }
  body { margin:0; font:14px/1.5 ui-monospace,SFMono-Regular,Menlo,monospace; background:var(--bg); color:var(--fg); }
  header { padding:.75rem 1rem; border-bottom:1px solid var(--line); display:flex; gap:1.5rem; flex-wrap:wrap; align-items:baseline; }
  h1 { font-size:14px; margin:0; font-weight:600; }
  .meta { color:var(--dim); font-size:12px; }
  [data-state="connected"] { color:#16a34a; }
  [data-state="closed"], [data-state="closing"] { color:#dc2626; }
  main { display:grid; grid-template-columns: 1fr 1fr; height: calc(100vh - 52px); }
  @media (max-width: 800px) { main { grid-template-columns: 1fr; grid-template-rows: 1fr 1fr; } }
  section { display:flex; flex-direction:column; min-width:0; min-height:0; }
  section + section { border-left:1px solid var(--line); }
  .label { padding:.5rem 1rem; border-bottom:1px solid var(--line); color:var(--dim); font-size:12px; }
  #log { flex:1; overflow-y:auto; padding:.5rem 1rem; }
  .line { padding:.1rem 0; white-space:pre-wrap; word-break:break-word; }
  form { display:flex; gap:.5rem; padding:.75rem 1rem; border-top:1px solid var(--line); }
  input { flex:1; font:inherit; padding:.4rem .6rem; background:transparent; color:var(--fg); border:1px solid var(--line); border-radius:4px; }
  button { font:inherit; padding:.4rem .9rem; border:1px solid var(--accent); background:var(--accent); color:#fff; border-radius:4px; cursor:pointer; }
  #surface { flex:1; position:relative; overflow:hidden; cursor:crosshair; }
  .cursor { position:absolute; top:0; left:0; width:10px; height:10px; border-radius:50%; background:var(--accent); transition:transform 60ms linear; pointer-events:none; }
  .cursor::after { content:attr(data-name); position:absolute; left:14px; top:-2px; font-size:11px; color:var(--dim); white-space:nowrap; }
</style>
</head>
<body>
<header>
  <h1>transport-io</h1>
  <span class="meta">status <span id="status" data-state="idle">idle</span></span>
  <span class="meta">rooms <span id="rooms">-</span></span>
  <span class="meta">drops <span id="drops">-</span></span>
  <span class="meta">received <span id="rx-chat">0</span> chat &middot; <span id="rx-cursor">0</span> cursor</span>
</header>
<main>
  <section>
    <div class="label">chat - <strong>stream lane</strong>, reliable and ordered. Nothing here is ever lost.</div>
    <div id="log"></div>
    <form id="composer"><input id="body" placeholder="say something" autocomplete="off" /><button>send</button></form>
  </section>
  <section>
    <div class="label">cursors - <strong>datagram lane</strong>, unreliable. Move your pointer; dropped frames are normal. The slider makes the server drop that share of your frames before sending them, so the other window sees the loss.</div>
    <div id="surface"></div>
  </section>
</main>
<script type="module" src="/dist/main.js"></script>
</body>
</html>
```

```ts file=web/main.ts
import { Client, type TransportError } from 'transport-io'
import { connectDev } from 'transport-io/dev-transport'
import { type ChatMap, contract } from '../contract.ts'

function byId(id: string) {
  const el = document.getElementById(id)
  if (el === null) throw new Error(`missing #${id}`)
  return el
}

const log = byId('log')
const form = byId('composer')
const input = byId('body') as HTMLInputElement
const statusEl = byId('status')
const roomsEl = byId('rooms')
const dropsEl = byId('drops')
const rxChatEl = byId('rx-chat')
const rxCursorEl = byId('rx-cursor')
const surface = byId('surface')

const me = `guest-${Math.random().toString(36).slice(2, 6)}`
const cursors = new Map<string, HTMLDivElement>()

/** Returns the line, so a streaming response can keep writing into it. */
function append(from: string, body: string, at: number) {
  const line = document.createElement('div')
  line.className = 'line'
  const time = new Date(at).toLocaleTimeString()
  line.textContent = `${time}  ${from}: ${body}`
  log.append(line)
  log.scrollTop = log.scrollHeight
  return line
}

function moveCursor(from: string, x: number, y: number) {
  let dot = cursors.get(from)
  if (dot === undefined) {
    dot = document.createElement('div')
    dot.className = 'cursor'
    dot.dataset.name = from
    surface.append(dot)
    cursors.set(from, dot)
  }
  dot.style.transform = `translate(${x}px, ${y}px)`
}

// new Client, so the page can show "connecting"
const client = new Client<ChatMap>({ contract, connect: () => connectDev() })

client.subscribe(() => {
  const s = client.getSnapshot()
  statusEl.textContent = s.status
  statusEl.dataset.state = s.status
  roomsEl.textContent = s.rooms.join(', ') || '-'
  if (s.lastError !== null)
    append('system', `${s.lastError.code}: ${s.lastError.remedy}`, Date.now())
})

let rxChat = 0
let rxCursor = 0
client.on('chat', ({ from, body, at }) => {
  rxChatEl.textContent = String(++rxChat)
  append(from, body, at)
})
client.on('cursor', ({ from, x, y }) => {
  rxCursorEl.textContent = String(++rxCursor)
  moveCursor(from, x, y)
})

try {
  await client.connect()
} catch (e) {
  const err = e as TransportError
  append('system', `could not connect - ${err.code}: ${err.remedy}`, Date.now())
  throw e
}

form.addEventListener('submit', (e) => {
  e.preventDefault()
  const body = input.value.trim()
  if (body.length === 0) return
  input.value = ''
  client.emit('chat', { from: me, body, at: Date.now() })
})

surface.addEventListener('pointermove', (e) => {
  const r = surface.getBoundingClientRect()
  client.emit('cursor', {
    from: me,
    x: Math.round(e.clientX - r.left),
    y: Math.round(e.clientY - r.top),
  })
})

setInterval(() => {
  const s = client.stats()
  if (s === undefined) return
  // Our own queue drops. The transport reports no network loss.
  dropsEl.textContent = `overflow ${s.overflowDropped} · stale ${s.staleDropped} · dedup ${s.staleReceived}`
}, 500)
```

`connectDev()` fetches the certificate hash the command published and connects with it. `new
Client` rather than a connected client, so the page can show `connecting` before it is.
`client.subscribe` fires on every change to the connection state; `client.on` receives an
event; `client.emit` sends one on whatever lane the contract declared. `client.stats()` counts
the drops this library made itself, in its own queue; the transport reports no network loss,
so those are the only numbers there are.

Bundle the page and start the server:

```bash
bun build web/main.ts --outdir web/dist --target browser
npx transport-io dev server.node.ts --static web
```

With `esbuild` instead: `npx esbuild web/main.ts --bundle --format=esm --outfile=web/dist/main.js`.

`--static web` names the directory to serve. Without it the command serves the first of
`public`, `web/dist`, `web` and `dist` that exists, and after the build that is `web/dist`,
which has no page in it.

Open the printed URL in two windows, in Chrome or Firefox. Type in one; it appears in both,
with a time and a guest name. Move the pointer over the right half of one window; a dot
follows it in the other. Watch the `received` counts in the header: chat counts match what you
sent, cursor counts do not, and the difference is the unreliable lane doing what it declared.

## 6. A name from a call

A call is a request with one answer, on its own QUIC stream. Add one to the contract:

```ts file=contract.ts
import { defineContract, type MapOf, reliable, rpc, unreliable } from 'transport-io'

export const contract = defineContract({
  chat: reliable<{ from: string; body: string; at: number }>(),
  cursor: unreliable<{ from: string; x: number; y: number }>(),
  setName: rpc<{ name: string }, { accepted: boolean; name: string }>(),
})

export interface ChatMap extends MapOf<typeof contract> {}
```

`rpc` declares the payload and the answer. Handle it on the server:

```ts file=app.ts
/** The handlers, attached to whichever server hosts the contract. */
import type { Server } from 'transport-io'
import type { ChatMap } from './contract.ts'

export interface AttachOptions {
  room?: string
  log?: (line: string) => void
}

export function attach(server: Server<ChatMap>, opts: AttachOptions = {}) {
  const room = opts.room ?? 'lobby'
  const log = opts.log ?? console.log

  const online = new Set<string>()

  server.handle('setName', async ({ name }) => {
    const trimmed = name.trim().slice(0, 24)
    if (trimmed.length === 0) return { accepted: false, name: '' }
    return { accepted: true, name: trimmed }
  })

  server.onSession((peer) => {
    void peer.join(room)
    online.add(peer.id)
    log(`+ ${peer.id} joined (${online.size} online)`)

    peer.on('chat', (msg) => {
      // To everyone, the sender included.
      void server.to(room).emit('chat', { ...msg, at: Date.now() })
    })

    peer.on('cursor', (pos) => {
      void server.to(room).except(peer.id).emit('cursor', pos)
    })
  })
}
```

And ask for it from the page, right after connecting:

```ts file=web/main.ts
import { Client, type TransportError } from 'transport-io'
import { connectDev } from 'transport-io/dev-transport'
import { type ChatMap, contract } from '../contract.ts'

function byId(id: string) {
  const el = document.getElementById(id)
  if (el === null) throw new Error(`missing #${id}`)
  return el
}

const log = byId('log')
const form = byId('composer')
const input = byId('body') as HTMLInputElement
const statusEl = byId('status')
const roomsEl = byId('rooms')
const dropsEl = byId('drops')
const rxChatEl = byId('rx-chat')
const rxCursorEl = byId('rx-cursor')
const surface = byId('surface')

const me = `guest-${Math.random().toString(36).slice(2, 6)}`
const cursors = new Map<string, HTMLDivElement>()

/** Returns the line, so a streaming response can keep writing into it. */
function append(from: string, body: string, at: number) {
  const line = document.createElement('div')
  line.className = 'line'
  const time = new Date(at).toLocaleTimeString()
  line.textContent = `${time}  ${from}: ${body}`
  log.append(line)
  log.scrollTop = log.scrollHeight
  return line
}

function moveCursor(from: string, x: number, y: number) {
  let dot = cursors.get(from)
  if (dot === undefined) {
    dot = document.createElement('div')
    dot.className = 'cursor'
    dot.dataset.name = from
    surface.append(dot)
    cursors.set(from, dot)
  }
  dot.style.transform = `translate(${x}px, ${y}px)`
}

// new Client, so the page can show "connecting"
const client = new Client<ChatMap>({ contract, connect: () => connectDev() })

client.subscribe(() => {
  const s = client.getSnapshot()
  statusEl.textContent = s.status
  statusEl.dataset.state = s.status
  roomsEl.textContent = s.rooms.join(', ') || '-'
  if (s.lastError !== null)
    append('system', `${s.lastError.code}: ${s.lastError.remedy}`, Date.now())
})

let rxChat = 0
let rxCursor = 0
client.on('chat', ({ from, body, at }) => {
  rxChatEl.textContent = String(++rxChat)
  append(from, body, at)
})
client.on('cursor', ({ from, x, y }) => {
  rxCursorEl.textContent = String(++rxCursor)
  moveCursor(from, x, y)
})

try {
  await client.connect()
} catch (e) {
  const err = e as TransportError
  append('system', `could not connect - ${err.code}: ${err.remedy}`, Date.now())
  throw e
}

const named = await client.call('setName', { name: me }, { signal: AbortSignal.timeout(5_000) })
append('system', named.accepted ? `you are ${named.name}` : 'name rejected', Date.now())

form.addEventListener('submit', (e) => {
  e.preventDefault()
  const body = input.value.trim()
  if (body.length === 0) return
  input.value = ''
  client.emit('chat', { from: named.name, body, at: Date.now() })
})

surface.addEventListener('pointermove', (e) => {
  const r = surface.getBoundingClientRect()
  client.emit('cursor', {
    from: named.name,
    x: Math.round(e.clientX - r.left),
    y: Math.round(e.clientY - r.top),
  })
})

setInterval(() => {
  const s = client.stats()
  if (s === undefined) return
  // Our own queue drops. The transport reports no network loss.
  dropsEl.textContent = `overflow ${s.overflowDropped} · stale ${s.staleDropped} · dedup ${s.staleReceived}`
}, 500)
```

`client.call` resolves with the answer, typed from the contract. The timeout is an
`AbortSignal`, and aborting is a reset of that one stream: no other call notices, and the
server's handler is told to stop. There is no default timeout; the page sets one.

Rebuild and restart. Each window now says `you are guest-…` from the server's answer, and
the name on every message is the one the server accepted.

## 7. A reply that streams

A streaming event answers with a sequence instead of a value. Add `say`:

```ts file=contract.ts
import { defineContract, type MapOf, reliable, rpc, streaming, unreliable } from 'transport-io'

export const contract = defineContract({
  chat: reliable<{ from: string; body: string; at: number }>(),
  cursor: unreliable<{ from: string; x: number; y: number }>(),
  /** Echoes the text one word at a time. */
  say: streaming<{ text: string }, string>(),
  setName: rpc<{ name: string }, { accepted: boolean; name: string }>(),
})

export interface ChatMap extends MapOf<typeof contract> {}
```

The handler is an async generator. Each `yield` is one frame on the stream, and the
generator runs at most 32 frames ahead of what the page has taken:

```ts file=app.ts
/** The handlers, attached to whichever server hosts the contract. */
import type { Server } from 'transport-io'
import type { ChatMap } from './contract.ts'

export interface AttachOptions {
  room?: string
  log?: (line: string) => void
}

export function attach(server: Server<ChatMap>, opts: AttachOptions = {}) {
  const room = opts.room ?? 'lobby'
  const log = opts.log ?? console.log

  const online = new Set<string>()

  server.handle('setName', async ({ name }) => {
    const trimmed = name.trim().slice(0, 24)
    if (trimmed.length === 0) return { accepted: false, name: '' }
    return { accepted: true, name: trimmed }
  })

  server.handle('say', async function* ({ text }) {
    for (const word of text.split(/\s+/).filter(Boolean)) {
      await new Promise((r) => setTimeout(r, 80))
      yield word
    }
  })

  server.onSession((peer) => {
    void peer.join(room)
    online.add(peer.id)
    log(`+ ${peer.id} joined (${online.size} online)`)

    peer.on('chat', (msg) => {
      // To everyone, the sender included.
      void server.to(room).emit('chat', { ...msg, at: Date.now() })
    })

    peer.on('cursor', (pos) => {
      void server.to(room).except(peer.id).emit('cursor', pos)
    })
  })
}
```

The page consumes it with `for await`, writing into one line as the words arrive:

```ts file=web/main.ts
import { Client, type TransportError } from 'transport-io'
import { connectDev } from 'transport-io/dev-transport'
import { type ChatMap, contract } from '../contract.ts'

function byId(id: string) {
  const el = document.getElementById(id)
  if (el === null) throw new Error(`missing #${id}`)
  return el
}

const log = byId('log')
const form = byId('composer')
const input = byId('body') as HTMLInputElement
const statusEl = byId('status')
const roomsEl = byId('rooms')
const dropsEl = byId('drops')
const rxChatEl = byId('rx-chat')
const rxCursorEl = byId('rx-cursor')
const surface = byId('surface')

const me = `guest-${Math.random().toString(36).slice(2, 6)}`
const cursors = new Map<string, HTMLDivElement>()

/** Returns the line, so a streaming response can keep writing into it. */
function append(from: string, body: string, at: number) {
  const line = document.createElement('div')
  line.className = 'line'
  const time = new Date(at).toLocaleTimeString()
  line.textContent = `${time}  ${from}: ${body}`
  log.append(line)
  log.scrollTop = log.scrollHeight
  return line
}

function moveCursor(from: string, x: number, y: number) {
  let dot = cursors.get(from)
  if (dot === undefined) {
    dot = document.createElement('div')
    dot.className = 'cursor'
    dot.dataset.name = from
    surface.append(dot)
    cursors.set(from, dot)
  }
  dot.style.transform = `translate(${x}px, ${y}px)`
}

// new Client, so the page can show "connecting"
const client = new Client<ChatMap>({ contract, connect: () => connectDev() })

client.subscribe(() => {
  const s = client.getSnapshot()
  statusEl.textContent = s.status
  statusEl.dataset.state = s.status
  roomsEl.textContent = s.rooms.join(', ') || '-'
  if (s.lastError !== null)
    append('system', `${s.lastError.code}: ${s.lastError.remedy}`, Date.now())
})

let rxChat = 0
let rxCursor = 0
client.on('chat', ({ from, body, at }) => {
  rxChatEl.textContent = String(++rxChat)
  append(from, body, at)
})
client.on('cursor', ({ from, x, y }) => {
  rxCursorEl.textContent = String(++rxCursor)
  moveCursor(from, x, y)
})

try {
  await client.connect()
} catch (e) {
  const err = e as TransportError
  append('system', `could not connect - ${err.code}: ${err.remedy}`, Date.now())
  throw e
}

const named = await client.call('setName', { name: me }, { signal: AbortSignal.timeout(5_000) })
append('system', named.accepted ? `you are ${named.name}` : 'name rejected', Date.now())

form.addEventListener('submit', (e) => {
  e.preventDefault()
  const body = input.value.trim()
  if (body.length === 0) return
  input.value = ''

  if (body.startsWith('/say ')) {
    void (async () => {
      const line = append('stream', '', Date.now())
      for await (const word of client.stream('say', { text: body.slice(5) })) {
        line.textContent = `${line.textContent ?? ''}${word} `
      }
    })()
    return
  }

  client.emit('chat', { from: named.name, body, at: Date.now() })
})

surface.addEventListener('pointermove', (e) => {
  const r = surface.getBoundingClientRect()
  client.emit('cursor', {
    from: named.name,
    x: Math.round(e.clientX - r.left),
    y: Math.round(e.clientY - r.top),
  })
})

setInterval(() => {
  const s = client.stats()
  if (s === undefined) return
  // Our own queue drops. The transport reports no network loss.
  dropsEl.textContent = `overflow ${s.overflowDropped} · stale ${s.staleDropped} · dedup ${s.staleReceived}`
}, 500)
```

Rebuild and restart. Type `/say one word at a time` and watch the line grow in place. The
loop ends when the server stops; leaving it early, with `break` or by navigating away, resets
the stream and the server's generator ends where it stands.

## 8. Watch the unreliable lane lose frames

The last event lets a window ask the server to drop a share of that window's own cursor
frames before broadcasting them, so the other window can watch the loss happen while chat
keeps arriving one for one.

```ts file=contract.ts
import { defineContract, type MapOf, reliable, rpc, streaming, unreliable } from 'transport-io'

export const contract = defineContract({
  chat: reliable<{ from: string; body: string; at: number }>(),
  cursor: unreliable<{ from: string; x: number; y: number }>(),
  /** Echoes the text one word at a time. */
  say: streaming<{ text: string }, string>(),
  setName: rpc<{ name: string }, { accepted: boolean; name: string }>(),
  /** The server drops this share of the caller's cursor frames before broadcasting. */
  setLoss: rpc<{ percent: number }, { percent: number }>(),
})

export interface ChatMap extends MapOf<typeof contract> {}
```

```ts file=app.ts
/** The handlers, attached to whichever server hosts the contract. */
import type { Server, ServerPeer } from 'transport-io'
import type { ChatMap } from './contract.ts'

export interface AttachOptions {
  room?: string
  log?: (line: string) => void
}

function clampPercent(n: number) {
  return Number.isFinite(n) ? Math.min(100, Math.max(0, Math.round(n))) : 0
}

export function attach(server: Server<ChatMap>, opts: AttachOptions = {}) {
  const room = opts.room ?? 'lobby'
  const log = opts.log ?? console.log

  const online = new Set<string>()
  // Keyed by the peer, so the entry goes when the session does.
  const loss = new WeakMap<ServerPeer<ChatMap>, number>()

  server.handle('setName', async ({ name }) => {
    const trimmed = name.trim().slice(0, 24)
    if (trimmed.length === 0) return { accepted: false, name: '' }
    return { accepted: true, name: trimmed }
  })

  // Answers with the clamped value, which is what the page shows.
  server.handle('setLoss', async ({ percent }, ctx) => {
    const p = clampPercent(percent)
    loss.set(ctx.peer, p / 100)
    return { percent: p }
  })

  server.handle('say', async function* ({ text }) {
    for (const word of text.split(/\s+/).filter(Boolean)) {
      await new Promise((r) => setTimeout(r, 80))
      yield word
    }
  })

  server.onSession((peer) => {
    void peer.join(room)
    online.add(peer.id)
    log(`+ ${peer.id} joined (${online.size} online)`)

    peer.on('chat', (msg) => {
      // To everyone, the sender included.
      void server.to(room).emit('chat', { ...msg, at: Date.now() })
    })

    peer.on('cursor', (pos) => {
      // Drops the caller's chosen share before broadcasting.
      const p = loss.get(peer) ?? 0
      if (p > 0 && Math.random() < p) return
      void server.to(room).except(peer.id).emit('cursor', pos)
    })
  })
}
```

The loss is kept per peer in a `WeakMap`, so it goes when the session does. The handler
answers with the clamped value, which is what the page shows.

Add the slider to the header:

```html file=web/index.html
<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<title>transport-io - chat with live cursors</title>
<style>
  :root { color-scheme: light dark; --bg:#fff; --fg:#111; --dim:#666; --line:#e5e5e5; --accent:#2563eb; }
  @media (prefers-color-scheme: dark) { :root { --bg:#111; --fg:#eee; --dim:#999; --line:#2a2a2a; } }
  * { box-sizing: border-box; }
  body { margin:0; font:14px/1.5 ui-monospace,SFMono-Regular,Menlo,monospace; background:var(--bg); color:var(--fg); }
  header { padding:.75rem 1rem; border-bottom:1px solid var(--line); display:flex; gap:1.5rem; flex-wrap:wrap; align-items:baseline; }
  h1 { font-size:14px; margin:0; font-weight:600; }
  .meta { color:var(--dim); font-size:12px; }
  [data-state="connected"] { color:#16a34a; }
  [data-state="closed"], [data-state="closing"] { color:#dc2626; }
  main { display:grid; grid-template-columns: 1fr 1fr; height: calc(100vh - 52px); }
  @media (max-width: 800px) { main { grid-template-columns: 1fr; grid-template-rows: 1fr 1fr; } }
  section { display:flex; flex-direction:column; min-width:0; min-height:0; }
  section + section { border-left:1px solid var(--line); }
  .label { padding:.5rem 1rem; border-bottom:1px solid var(--line); color:var(--dim); font-size:12px; }
  #log { flex:1; overflow-y:auto; padding:.5rem 1rem; }
  .line { padding:.1rem 0; white-space:pre-wrap; word-break:break-word; }
  form { display:flex; gap:.5rem; padding:.75rem 1rem; border-top:1px solid var(--line); }
  input { flex:1; font:inherit; padding:.4rem .6rem; background:transparent; color:var(--fg); border:1px solid var(--line); border-radius:4px; }
  button { font:inherit; padding:.4rem .9rem; border:1px solid var(--accent); background:var(--accent); color:#fff; border-radius:4px; cursor:pointer; }
  #surface { flex:1; position:relative; overflow:hidden; cursor:crosshair; }
  .cursor { position:absolute; top:0; left:0; width:10px; height:10px; border-radius:50%; background:var(--accent); transition:transform 60ms linear; pointer-events:none; }
  .cursor::after { content:attr(data-name); position:absolute; left:14px; top:-2px; font-size:11px; color:var(--dim); white-space:nowrap; }
</style>
</head>
<body>
<header>
  <h1>transport-io</h1>
  <span class="meta">status <span id="status" data-state="idle">idle</span></span>
  <span class="meta">rooms <span id="rooms">-</span></span>
  <span class="meta">drops <span id="drops">-</span></span>
  <span class="meta">received <span id="rx-chat">0</span> chat &middot; <span id="rx-cursor">0</span> cursor</span>
  <label class="meta" for="loss">drop <strong id="loss-value">0%</strong> of my cursor frames
    <input id="loss" type="range" min="0" max="100" step="10" value="0" style="vertical-align:middle;width:110px"></label>
</header>
<main>
  <section>
    <div class="label">chat - <strong>stream lane</strong>, reliable and ordered. Nothing here is ever lost.</div>
    <div id="log"></div>
    <form id="composer"><input id="body" placeholder="say something" autocomplete="off" /><button>send</button></form>
  </section>
  <section>
    <div class="label">cursors - <strong>datagram lane</strong>, unreliable. Move your pointer; dropped frames are normal. The slider makes the server drop that share of your frames before sending them, so the other window sees the loss.</div>
    <div id="surface"></div>
  </section>
</main>
<script type="module" src="/dist/main.js"></script>
</body>
</html>
```

And the page's last two additions: the slider's elements at the top, and its listener at the
bottom.

```ts file=web/main.ts
import { Client, type TransportError } from 'transport-io'
import { connectDev } from 'transport-io/dev-transport'
import { type ChatMap, contract } from '../contract.ts'

function byId(id: string) {
  const el = document.getElementById(id)
  if (el === null) throw new Error(`missing #${id}`)
  return el
}

const log = byId('log')
const form = byId('composer')
const input = byId('body') as HTMLInputElement
const statusEl = byId('status')
const roomsEl = byId('rooms')
const dropsEl = byId('drops')
const rxChatEl = byId('rx-chat')
const rxCursorEl = byId('rx-cursor')
const lossEl = byId('loss') as HTMLInputElement
const lossValueEl = byId('loss-value')
const surface = byId('surface')

const me = `guest-${Math.random().toString(36).slice(2, 6)}`
const cursors = new Map<string, HTMLDivElement>()

/** Returns the line, so a streaming response can keep writing into it. */
function append(from: string, body: string, at: number) {
  const line = document.createElement('div')
  line.className = 'line'
  const time = new Date(at).toLocaleTimeString()
  line.textContent = `${time}  ${from}: ${body}`
  log.append(line)
  log.scrollTop = log.scrollHeight
  return line
}

function moveCursor(from: string, x: number, y: number) {
  let dot = cursors.get(from)
  if (dot === undefined) {
    dot = document.createElement('div')
    dot.className = 'cursor'
    dot.dataset.name = from
    surface.append(dot)
    cursors.set(from, dot)
  }
  dot.style.transform = `translate(${x}px, ${y}px)`
}

// new Client, so the page can show "connecting"
const client = new Client<ChatMap>({ contract, connect: () => connectDev() })

client.subscribe(() => {
  const s = client.getSnapshot()
  statusEl.textContent = s.status
  statusEl.dataset.state = s.status
  roomsEl.textContent = s.rooms.join(', ') || '-'
  if (s.lastError !== null)
    append('system', `${s.lastError.code}: ${s.lastError.remedy}`, Date.now())
})

let rxChat = 0
let rxCursor = 0
client.on('chat', ({ from, body, at }) => {
  rxChatEl.textContent = String(++rxChat)
  append(from, body, at)
})
client.on('cursor', ({ from, x, y }) => {
  rxCursorEl.textContent = String(++rxCursor)
  moveCursor(from, x, y)
})

try {
  await client.connect()
} catch (e) {
  const err = e as TransportError
  append('system', `could not connect - ${err.code}: ${err.remedy}`, Date.now())
  throw e
}

const named = await client.call('setName', { name: me }, { signal: AbortSignal.timeout(5_000) })
append('system', named.accepted ? `you are ${named.name}` : 'name rejected', Date.now())

form.addEventListener('submit', (e) => {
  e.preventDefault()
  const body = input.value.trim()
  if (body.length === 0) return
  input.value = ''

  if (body.startsWith('/say ')) {
    void (async () => {
      const line = append('stream', '', Date.now())
      for await (const word of client.stream('say', { text: body.slice(5) })) {
        line.textContent = `${line.textContent ?? ''}${word} `
      }
    })()
    return
  }

  client.emit('chat', { from: named.name, body, at: Date.now() })
})

// The label shows what the server set, not what the slider asked for.
lossEl.addEventListener('input', () => {
  void client.call('setLoss', { percent: Number(lossEl.value) }).then(({ percent }) => {
    lossValueEl.textContent = `${percent}%`
  })
})

surface.addEventListener('pointermove', (e) => {
  const r = surface.getBoundingClientRect()
  client.emit('cursor', {
    from: named.name,
    x: Math.round(e.clientX - r.left),
    y: Math.round(e.clientY - r.top),
  })
})

setInterval(() => {
  const s = client.stats()
  if (s === undefined) return
  // Our own queue drops. The transport reports no network loss.
  dropsEl.textContent = `overflow ${s.overflowDropped} · stale ${s.staleDropped} · dedup ${s.staleReceived}`
}, 500)
```

Rebuild and restart. Drag the slider in one window and keep moving the pointer: the other
window's cursor count stalls while its chat count does not. That is the whole difference
between the two lanes, on screen.

You have a chat with cursors, in your own project, running. What follows is the second page
of the example, and it is optional.

## 9. The second page: two streams at once

`examples/chat` has a second page that runs two streaming calls at the same time and lets you
stop either one. It is the shortest answer to why this is not a WebSocket, and it is what the
screenshot on the front page shows. Adding it brings this project to the example exactly.

One more event, `generate`, which streams a fixed script one token at a time:

```ts file=contract.ts
import { defineContract, type MapOf, reliable, rpc, streaming, unreliable } from 'transport-io'

export const contract = defineContract({
  chat: reliable<{ from: string; body: string; at: number }>(),
  cursor: unreliable<{ from: string; x: number; y: number }>(),
  /** Echoes the text one word at a time. */
  say: streaming<{ text: string }, string>(),
  setName: rpc<{ name: string }, { accepted: boolean; name: string }>(),
  /** The server drops this share of the caller's cursor frames before broadcasting. */
  setLoss: rpc<{ percent: number }, { percent: number }>(),
  /** Streams a fixed script one token at a time. */
  generate: streaming<{ agent: string }, string>(),
})

export interface ChatMap extends MapOf<typeof contract> {}
```

The scripts, and a pace for each token:

```ts file=agents.ts
/** The scripts behind `generate`. No model is called. */

export interface Agent {
  /** Shown above the panel. */
  question: string
  /** Milliseconds between tokens, before jitter. */
  pace: number
  tokens: string[]
}

/**
 * Tokens keep their trailing whitespace. Newlines inside a paragraph collapse to a space;
 * blank lines survive.
 */
function tokenize(script: string) {
  const text = script
    .trim()
    .split(/\n\s*\n/)
    .map((paragraph) => paragraph.replace(/\s+/g, ' ').trim())
    .join('\n\n')
  return text.match(/\S+\s*/g) ?? []
}

const AGENT_A = `
Because these two panels are not sharing a pipe.

Each panel called stream() once, and each call opened its own bidirectional QUIC stream
inside the one WebTransport session. QUIC orders bytes within a stream and promises nothing
at all across streams, so the tokens filling this panel and the tokens filling the one
beside it are two independent sequences that happen to share a UDP flow.

When you press stop, the client resets this stream. That reset is a frame on the wire
carrying a code, and the generator producing this text is cancelled the moment it arrives,
so production ends at the source rather than continuing into a reader that has looked away.
None of that touches the other stream. It has its own ordering, its own flow control and its
own credit, and it goes on delivering at the rate it was already delivering.

The number that appears beside the other panel starts at zero the moment you press stop and
counts what has arrived since. If these two were sharing one ordered channel, that number
would sit still for as long as this stream took to unwind. Watching it not sit still is a
different kind of claim from a paragraph telling you it would not.

On a WebSocket both of these would be multiplexed over one TCP connection, framed by hand to
tell them apart, and a stop would be a message you send and then wait to have honoured. Here
it is a property of the transport.

Nothing else about the session changes either. The connection stays up, room membership
stays put, and if you press restart under this panel a new stream opens beside the one still
running. Streams are cheap, because that is what QUIC is for. There is no pool to exhaust
and no queue to be stuck behind, so a slow answer is slow on its own and takes nothing else
down with it.
`

const AGENT_B = `
Tokens, one frame each, on a stream opened for this request and closed when the answer ends.

The library hides the framing and hides nothing else. Every frame carries a length prefix,
because stream reads do not preserve write boundaries: a handful of small writes and one
large one arrive as an arbitrary number of reads with the boundaries gone. Nobody using this
library should ever write that code, which is why it is not in your way here.

Before any of this, the two ends agreed on what the events are. The first frame of the
session carries the contract: every event name, the identifier it hashes to, and the lane it
travels on. A peer that disagrees is refused at that frame, rather than at the first message
that fails to parse an hour later.

The pacing you are watching is not the transport's doing either. The reference transport
applies no write backpressure worth the name, so a producer left to itself will run
arbitrarily far ahead of a consumer that has taken almost nothing. This library keeps its
own credit window instead: a responder runs a bounded number of frames ahead of what its
consumer has actually taken. That is why this panel cannot be flooded, and why a slow reader
slows its own stream and no other.

This stream is the reliable half. The other half is datagrams, and it exists because some
data is worse for arriving late than for not arriving at all: a cursor position, a frame of
audio, the current value of anything that changes faster than you can draw it. Which half an
event uses is settled in the contract, once, and never at the call site, so nobody can
quietly make a droppable message reliable in order to close a bug.

The words themselves are generated on the server from a fixed script. No model is called.
What is real is everything underneath them: real QUIC over real UDP, a real certificate, and
two real streams that do not know about each other.
`

export const AGENTS: Record<string, Agent> = {
  'agent-a': {
    question: 'Why does stopping this panel not affect the other one?',
    pace: 55,
    tokens: tokenize(AGENT_A),
  },
  'agent-b': {
    question: 'What is actually on the wire?',
    pace: 64,
    tokens: tokenize(AGENT_B),
  },
}

/** Jitter derived from the index, so every run paces identically. */
export function paceOf(agent: Agent, index: number) {
  const noise = ((Math.imul(index + 1, 2654435761) >>> 0) % 1000) / 1000
  return Math.round(agent.pace * (0.55 + 0.9 * noise))
}
```

The handler, with a cap on how many generations one session may run at once, and a log line
when a caller stops one:

```ts file=app.ts
/** The handlers, attached to whichever server hosts the contract. */
import type { Server, ServerPeer } from 'transport-io'
import { AGENTS, paceOf } from './agents.ts'
import type { ChatMap } from './contract.ts'

export interface AttachOptions {
  /** Concurrent `generate` streams one session may hold. Unlimited when absent. */
  maxGenerationsPerPeer?: number
  room?: string
  log?: (line: string) => void
}

function clampPercent(n: number) {
  return Number.isFinite(n) ? Math.min(100, Math.max(0, Math.round(n))) : 0
}

export function attach(server: Server<ChatMap>, opts: AttachOptions = {}) {
  const room = opts.room ?? 'lobby'
  const log = opts.log ?? console.log
  const maxGenerations = opts.maxGenerationsPerPeer ?? Number.POSITIVE_INFINITY

  const online = new Set<string>()
  // Keyed by the peer, so the entry goes when the session does.
  const loss = new WeakMap<ServerPeer<ChatMap>, number>()
  const generating = new WeakMap<ServerPeer<ChatMap>, number>()

  server.handle('setName', async ({ name }) => {
    const trimmed = name.trim().slice(0, 24)
    if (trimmed.length === 0) return { accepted: false, name: '' }
    return { accepted: true, name: trimmed }
  })

  // Answers with the clamped value, which is what the page shows.
  server.handle('setLoss', async ({ percent }, ctx) => {
    const p = clampPercent(percent)
    loss.set(ctx.peer, p / 100)
    return { percent: p }
  })

  server.handle('say', async function* ({ text }) {
    for (const word of text.split(/\s+/).filter(Boolean)) {
      await new Promise((r) => setTimeout(r, 80))
      yield word
    }
  })

  server.handle('generate', async function* ({ agent }, ctx) {
    const script = AGENTS[agent]
    if (script === undefined) throw new Error(`unknown agent '${agent}'`)
    const active = generating.get(ctx.peer) ?? 0
    if (active >= maxGenerations) {
      throw new Error(`at most ${maxGenerations} generations at once on one session`)
    }
    generating.set(ctx.peer, active + 1)
    let sent = 0
    try {
      for (const [i, token] of script.tokens.entries()) {
        await new Promise((r) => setTimeout(r, paceOf(script, i)))
        yield token
        sent++
      }
      log(`generate ${agent}: done, ${sent} tokens`)
    } finally {
      generating.set(ctx.peer, (generating.get(ctx.peer) ?? 1) - 1)
      if (ctx.signal.aborted) log(`generate ${agent}: cancelled after ${sent} tokens`)
    }
  })

  server.onSession((peer) => {
    void peer.join(room)
    online.add(peer.id)
    log(`+ ${peer.id} joined (${online.size} online)`)

    peer.on('chat', (msg) => {
      // To everyone, the sender included.
      void server.to(room).emit('chat', { ...msg, at: Date.now() })
    })

    peer.on('cursor', (pos) => {
      // Drops the caller's chosen share before broadcasting.
      const p = loss.get(peer) ?? 0
      if (p > 0 && Math.random() < p) return
      void server.to(room).except(peer.id).emit('cursor', pos)
    })
  })
}
```

`ctx.signal.aborted` in the `finally` is how the handler learns that the caller reset the
stream rather than reading it to the end.

The page, and a link to it from the first one:

```html file=web/agents.html
<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<title>transport-io - two streams, one session</title>
<style>
  :root { color-scheme: light dark; --bg:#fff; --fg:#111; --dim:#666; --line:#e5e5e5; --accent:#2563eb; --stop:#dc2626; --panel:#fafafa; }
  @media (prefers-color-scheme: dark) { :root { --bg:#111; --fg:#eee; --dim:#999; --line:#2a2a2a; --panel:#161616; } }
  * { box-sizing: border-box; }
  body { margin:0; font:14px/1.6 ui-monospace,SFMono-Regular,Menlo,monospace; background:var(--bg); color:var(--fg); height:100vh; display:flex; flex-direction:column; }
  header { padding:.75rem 1rem; border-bottom:1px solid var(--line); display:flex; gap:1.5rem; flex-wrap:wrap; align-items:baseline; }
  h1 { font-size:14px; margin:0; font-weight:600; }
  .meta { color:var(--dim); font-size:12px; }
  .meta strong { color:var(--fg); font-variant-numeric:tabular-nums; }
  [data-state="connected"], [data-state="streaming"] { color:#16a34a; }
  [data-state="closed"], [data-state="closing"], [data-state="stopped"] { color:var(--stop); }
  header button { margin-left:auto; }
  main { display:grid; grid-template-columns:1fr 1fr; flex:1; min-height:0; }
  @media (max-width: 860px) { main { grid-template-columns:1fr; grid-template-rows:1fr 1fr; } }
  section { display:flex; flex-direction:column; min-width:0; min-height:0; }
  section + section { border-left:1px solid var(--line); }
  @media (max-width: 860px) { section + section { border-left:0; border-top:1px solid var(--line); } }
  .label { padding:.6rem 1rem; border-bottom:1px solid var(--line); display:flex; gap:.6rem; align-items:baseline; flex-wrap:wrap; }
  .label strong { font-size:13px; }
  .q { color:var(--dim); font-size:12px; }
  .out { flex:1; overflow-y:auto; padding:1rem; white-space:pre-wrap; word-break:break-word; background:var(--panel); }
  .stats { padding:.5rem 1rem; border-top:1px solid var(--line); display:flex; gap:1.1rem; flex-wrap:wrap; align-items:baseline; font-size:12px; color:var(--dim); }
  .stats strong { color:var(--fg); font-variant-numeric:tabular-nums; }
  .since:not(:empty) { color:#16a34a; }
  .controls { padding:.6rem 1rem .8rem; display:flex; gap:.5rem; border-top:1px solid var(--line); }
  button { font:inherit; font-size:13px; padding:.35rem .9rem; border-radius:4px; cursor:pointer; border:1px solid var(--stop); background:var(--stop); color:#fff; }
  button.ghost { border-color:var(--line); background:transparent; color:var(--dim); }
  footer { padding:.75rem 1rem; border-top:1px solid var(--line); color:var(--dim); font-size:12px; }
  footer p { margin:0 0 .35rem; }
  footer p:last-child { margin-bottom:0; }
</style>
</head>
<body>
<header>
  <h1>transport-io</h1>
  <span class="meta">status <span id="status" data-state="idle">idle</span></span>
  <span class="meta">open streams <strong id="open">0</strong></span>
  <a class="meta" href="/">chat and cursors &rarr;</a>
  <button id="restart" class="ghost" type="button">restart both</button>
</header>
<main>
  <section>
    <div class="label"><strong>agent-a</strong><span class="q" id="a-question"></span></div>
    <div class="out" id="a-out"></div>
    <div class="stats">
      <span id="a-state" data-state="idle">idle</span>
      <span><strong id="a-tokens">0</strong> tokens</span>
      <span><strong id="a-rate">0.0</strong> tok/s</span>
      <span class="since" id="a-since"></span>
    </div>
    <div class="controls">
      <button id="a-stop" type="button">stop</button>
      <button id="a-start" class="ghost" type="button">restart</button>
    </div>
  </section>
  <section>
    <div class="label"><strong>agent-b</strong><span class="q" id="b-question"></span></div>
    <div class="out" id="b-out"></div>
    <div class="stats">
      <span id="b-state" data-state="idle">idle</span>
      <span><strong id="b-tokens">0</strong> tokens</span>
      <span><strong id="b-rate">0.0</strong> tok/s</span>
      <span class="since" id="b-since"></span>
    </div>
    <div class="controls">
      <button id="b-stop" type="button">stop</button>
      <button id="b-start" class="ghost" type="button">restart</button>
    </div>
  </section>
</main>
<footer>
  <p>Stop either panel. The other's counter does not pause, and the number that appears beside
  it counts what arrived after you pressed stop.</p>
  <p>Two <code>stream()</code> calls, one session, one UDP flow, two independent QUIC streams.
  Stop is a transport reset rather than a message the server has to cooperate with: the
  responder's generator ends where it stands, and whatever it had already queued is dropped
  rather than delivered.</p>
  <p>The words are generated on the server from a fixed script. No model is called. Everything
  under them is real: QUIC over UDP, a pinned certificate, two live streams.</p>
</footer>
<script type="module" src="/dist/agents.js"></script>
</body>
</html>
```

```html file=web/index.html
<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<title>transport-io - chat with live cursors</title>
<style>
  :root { color-scheme: light dark; --bg:#fff; --fg:#111; --dim:#666; --line:#e5e5e5; --accent:#2563eb; }
  @media (prefers-color-scheme: dark) { :root { --bg:#111; --fg:#eee; --dim:#999; --line:#2a2a2a; } }
  * { box-sizing: border-box; }
  body { margin:0; font:14px/1.5 ui-monospace,SFMono-Regular,Menlo,monospace; background:var(--bg); color:var(--fg); }
  header { padding:.75rem 1rem; border-bottom:1px solid var(--line); display:flex; gap:1.5rem; flex-wrap:wrap; align-items:baseline; }
  h1 { font-size:14px; margin:0; font-weight:600; }
  .meta { color:var(--dim); font-size:12px; }
  [data-state="connected"] { color:#16a34a; }
  [data-state="closed"], [data-state="closing"] { color:#dc2626; }
  main { display:grid; grid-template-columns: 1fr 1fr; height: calc(100vh - 52px); }
  @media (max-width: 800px) { main { grid-template-columns: 1fr; grid-template-rows: 1fr 1fr; } }
  section { display:flex; flex-direction:column; min-width:0; min-height:0; }
  section + section { border-left:1px solid var(--line); }
  .label { padding:.5rem 1rem; border-bottom:1px solid var(--line); color:var(--dim); font-size:12px; }
  #log { flex:1; overflow-y:auto; padding:.5rem 1rem; }
  .line { padding:.1rem 0; white-space:pre-wrap; word-break:break-word; }
  form { display:flex; gap:.5rem; padding:.75rem 1rem; border-top:1px solid var(--line); }
  input { flex:1; font:inherit; padding:.4rem .6rem; background:transparent; color:var(--fg); border:1px solid var(--line); border-radius:4px; }
  button { font:inherit; padding:.4rem .9rem; border:1px solid var(--accent); background:var(--accent); color:#fff; border-radius:4px; cursor:pointer; }
  #surface { flex:1; position:relative; overflow:hidden; cursor:crosshair; }
  .cursor { position:absolute; top:0; left:0; width:10px; height:10px; border-radius:50%; background:var(--accent); transition:transform 60ms linear; pointer-events:none; }
  .cursor::after { content:attr(data-name); position:absolute; left:14px; top:-2px; font-size:11px; color:var(--dim); white-space:nowrap; }
</style>
</head>
<body>
<header>
  <h1>transport-io</h1>
  <span class="meta">status <span id="status" data-state="idle">idle</span></span>
  <span class="meta">rooms <span id="rooms">-</span></span>
  <span class="meta">drops <span id="drops">-</span></span>
  <span class="meta">received <span id="rx-chat">0</span> chat &middot; <span id="rx-cursor">0</span> cursor</span>
  <label class="meta" for="loss">drop <strong id="loss-value">0%</strong> of my cursor frames
    <input id="loss" type="range" min="0" max="100" step="10" value="0" style="vertical-align:middle;width:110px"></label>
  <a class="meta" href="/agents.html">two streams at once &rarr;</a>
</header>
<main>
  <section>
    <div class="label">chat - <strong>stream lane</strong>, reliable and ordered. Nothing here is ever lost.</div>
    <div id="log"></div>
    <form id="composer"><input id="body" placeholder="say something" autocomplete="off" /><button>send</button></form>
  </section>
  <section>
    <div class="label">cursors - <strong>datagram lane</strong>, unreliable. Move your pointer; dropped frames are normal. The slider makes the server drop that share of your frames before sending them, so the other window sees the loss.</div>
    <div id="surface"></div>
  </section>
</main>
<script type="module" src="/dist/main.js"></script>
</body>
</html>
```

```ts file=web/agents.ts
import { Client, type TransportError } from 'transport-io'
import { connectDev } from 'transport-io/dev-transport'
import { AGENTS } from '../agents.ts'
import { type ChatMap, contract } from '../contract.ts'

function byId(id: string) {
  const el = document.getElementById(id)
  if (el === null) throw new Error(`missing #${id}`)
  return el
}

const statusEl = byId('status')
const openEl = byId('open')

const live = new Set<string>()
function setLive(id: string, streaming: boolean) {
  if (streaming) live.add(id)
  else live.delete(id)
  openEl.textContent = String(live.size)
}

// new Client, so the page can show "connecting"
const client = new Client<ChatMap>({ contract, connect: () => connectDev() })

client.subscribe(() => {
  const s = client.getSnapshot()
  statusEl.textContent = s.status
  statusEl.dataset.state = s.status
})

function makePanel(id: string, name: string) {
  const agent = AGENTS[name]
  if (agent === undefined) throw new Error(`unknown agent '${name}'`)

  const out = byId(`${id}-out`)
  const stateEl = byId(`${id}-state`)
  const tokensEl = byId(`${id}-tokens`)
  const rateEl = byId(`${id}-rate`)
  const sinceEl = byId(`${id}-since`)
  byId(`${id}-question`).textContent = agent.question

  /** Bumped by every start, so a superseded loop writes nothing to the DOM. */
  let generation = 0
  let handle: { cancel(): void } | null = null
  let tokens = 0
  let startedAt = 0
  let sinceBase: number | null = null
  let sinceLabel = ''

  function setState(state: string) {
    stateEl.textContent = state
    stateEl.dataset.state = state
    setLive(id, state === 'streaming')
  }

  function render() {
    tokensEl.textContent = String(tokens)
    const seconds = (performance.now() - startedAt) / 1000
    rateEl.textContent = seconds > 0.25 ? (tokens / seconds).toFixed(1) : '0.0'
    sinceEl.textContent =
      sinceBase === null ? '' : `+${tokens - sinceBase} since ${sinceLabel} stopped`
  }

  async function begin() {
    handle?.cancel()
    const mine = ++generation

    out.textContent = ''
    tokens = 0
    startedAt = performance.now()
    sinceBase = null
    setState('streaming')
    render()

    const result = client.stream('generate', { agent: name })
    handle = result
    try {
      for await (const token of result) {
        if (mine !== generation) return
        out.append(token)
        out.scrollTop = out.scrollHeight
        tokens++
        render()
      }
      if (mine === generation) setState('done')
    } catch (e) {
      if (mine !== generation) return
      const err = e as TransportError
      // WT_ABORTED is this page's own cancel(), so it reads as stopped rather than failed.
      setState(err.code === 'WT_ABORTED' ? 'stopped' : `failed: ${err.code}`)
    } finally {
      // Nothing left to stop, however it ended.
      if (mine === generation) handle = null
    }
  }

  return {
    start: () => void begin(),
    // True if a running stream was stopped.
    stop: () => {
      // Resets the stream; the loop above sees WT_ABORTED.
      if (handle === null) return false
      handle.cancel()
      handle = null
      return true
    },
    // Count from here, labelled with whichever panel just stopped.
    countFrom: (label: string) => {
      sinceBase = tokens
      sinceLabel = label
      render()
    },
    clearCount: () => {
      sinceBase = null
      render()
    },
  }
}

const a = makePanel('a', 'agent-a')
const b = makePanel('b', 'agent-b')

byId('a-stop').addEventListener('click', () => {
  if (a.stop()) b.countFrom('agent-a')
})
byId('b-stop').addEventListener('click', () => {
  if (b.stop()) a.countFrom('agent-b')
})
byId('a-start').addEventListener('click', () => {
  a.start()
  b.clearCount()
})
byId('b-start').addEventListener('click', () => {
  b.start()
  a.clearCount()
})
byId('restart').addEventListener('click', () => {
  a.start()
  b.start()
  a.clearCount()
  b.clearCount()
})

try {
  await client.connect()
} catch (e) {
  const err = e as TransportError
  statusEl.textContent = `${err.code}: ${err.remedy}`
  throw e
}

a.start()
b.start()
```

Each panel calls `client.stream('generate', …)` once and keeps the handle. `stop` calls
`cancel()` on it, which resets that stream; the loop sees `WT_ABORTED` and reads it as
stopped rather than failed. The `generation` counter is bumped by every start, so a loop that
was superseded writes nothing to the page.

Bundle both pages, and the scripts in `package.json` grow to match:

```json file=package.json
{
  "name": "chat",
  "private": true,
  "type": "module",
  "scripts": {
    "build:web": "bun build web/main.ts web/agents.ts --outdir web/dist --target browser",
    "dev": "bun run build:web && transport-io dev server.node.ts --static web",
    "start": "transport-io dev server.node.ts --static web"
  }
}
```

```bash
bun run dev
```

Open `/agents.html`. Both panels stream. Press **stop** under one: it freezes, `open streams`
drops from 2 to 1, and the other panel gains a counter that climbs from zero. Nothing about
the stopped stream cost the running one a token.

## Where next

- [The fallback](/guides/fallback/), for browsers without WebTransport and networks that
  block UDP.
- [React](/guides/react/), for the same chat on `@transport-io/react`.
