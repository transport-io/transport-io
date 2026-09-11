---
title: A chat with cursors
description: From an empty directory to a working chat with live cursors in React, one change at a time, ending at examples/react.
---

You start with nothing and end with a chat that works in two browser windows: messages that
always arrive, cursors that follow the pointer and are allowed to drop, a name assigned by a
call, a reply that streams in a word at a time, and a slider that makes the unreliable lane
visibly lose frames. The browser half is React, on `@transport-io/react`. Each file appears
complete once; after that, a step shows what changes, and the whole file is folded beneath
the change for anyone who wants it. The eight source files you write are the eight in
`examples/react` in the repository, byte for byte, and a check in that repository fails if
this page and that example ever disagree.

You need Node 22 or newer, and Chrome or Firefox.

## 1. An empty directory

```bash
mkdir chat && cd chat
npm init -y
npm install transport-io @transport-io/react react react-dom zod
npm install @fails-components/webtransport-transport-http3-quiche
npm install -D vite typescript @types/react @types/react-dom @types/node
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
    "dev": "vite",
    "server": "transport-io dev server.node.ts",
    "build": "vite build",
    "start": "transport-io dev server.node.ts --static dist"
  }
}
```

And add a `tsconfig.json`:

```json file=tsconfig.json
{
  "compilerOptions": {
    "strict": true,
    "noEmit": true,
    "module": "esnext",
    "moduleResolution": "bundler",
    "target": "es2023",
    "lib": ["es2023", "dom", "dom.iterable"],
    "types": ["node"],
    "jsx": "react-jsx",
    "allowImportingTsExtensions": true,
    "skipLibCheck": true
  },
  "include": ["**/*.ts", "**/*.tsx"]
}
```

`allowImportingTsExtensions` matters: every import in this project names its file with the
`.ts` or `.tsx` on, which is what Node runs directly and what Vite resolves.

## 2. The contract

One file says what every event is and whether it can be dropped. Both the server and the page
import it, and neither can send an event it does not name.

```ts file=contract.ts
import { defineContract, type MapOf, reliable, unreliable } from 'transport-io'
import { z } from 'zod'

export const contract = defineContract({
  chat: reliable(z.object({ from: z.string(), body: z.string().max(2000), at: z.number() })),
  cursor: unreliable(z.object({ from: z.string(), x: z.number(), y: z.number() })),
})

export interface ChatMap extends MapOf<typeof contract> {}
```

`chat` is `reliable`: it arrives, in order, or the session fails. `cursor` is `unreliable`:
it may be dropped, duplicated or reordered, and that is right for a cursor, because the next
position makes the last one worthless. The lane is declared here and nowhere else. The
payloads are zod schemas, so every message is validated on arrival, and the types the rest of
the project sees are inferred from them.

`ChatMap` is the second line, and it is the one to pass to a client, a server or the hooks.
Without it, every hover shows the whole contract with the validator's internals in it.

## 3. The server

```ts file=server.node.ts
/** The server. Started by `transport-io dev`, which mints the certificate. Node only. */
import { createServer } from 'transport-io'
import { listenDev } from 'transport-io/node-transport'
import { type ChatMap, contract } from './contract.ts'

const ROOM = 'lobby'
const server = createServer<ChatMap>({ contract })

server.onSession((peer) => {
  void peer.join(ROOM)
  peer.on('chat', (msg) => {
    // To everyone, the sender included.
    void server.to(ROOM).emit('chat', { ...msg, at: Date.now() })
  })
  peer.on('cursor', (pos) => {
    void server.to(ROOM).except(peer.id).emit('cursor', pos)
  })
})

await server.listen(await listenDev())
console.log('chat server ready')
```

Rooms are server-authoritative: a client cannot join by sending anything, so `peer.join` is
called here when a session arrives. `chat` goes to everyone in the room, the sender included,
with the time stamped on the server. `cursor` goes to everyone except the sender, because the
sender already knows where its own pointer is.

`listenDev()` reads the certificate that `transport-io dev` mints and passes in by
environment. The file is named `.node.ts` because it loads the native transport, which only
Node can run.

## 4. Run it

```bash
npm run server
```

That is `transport-io dev server.node.ts`. It prints the WebTransport URL and the
certificate's fingerprint, and says it found no static directory, because the page is Vite's
and does not exist yet. The server is up. Leave it running in this terminal.

## 5. The page

Six files. `index.html` carries the whole stylesheet, once, and is not printed again.

```html file=index.html
<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<title>transport-io - chat with live cursors, in React</title>
<style>
  :root { color-scheme: light dark; --bg:#fff; --fg:#111; --dim:#666; --line:#e5e5e5; --accent:#2563eb; }
  @media (prefers-color-scheme: dark) { :root { --bg:#111; --fg:#eee; --dim:#999; --line:#2a2a2a; } }
  * { box-sizing: border-box; }
  body { margin:0; font:14px/1.5 ui-monospace,SFMono-Regular,Menlo,monospace; background:var(--bg); color:var(--fg); }
  header { padding:.75rem 1rem; border-bottom:1px solid var(--line); display:flex; gap:1.5rem; flex-wrap:wrap; align-items:baseline; }
  h1 { font-size:14px; margin:0; font-weight:600; }
  .meta { color:var(--dim); font-size:12px; }
  [data-state="connected"] { color:#16a34a; }
  [data-state="closed"], [data-state="closing"], #error { color:#dc2626; }
  main { display:grid; grid-template-columns: 1fr 1fr; height: calc(100vh - 52px); }
  @media (max-width: 800px) { main { grid-template-columns: 1fr; grid-template-rows: 1fr 1fr; } }
  section { display:flex; flex-direction:column; min-width:0; min-height:0; }
  section + section { border-left:1px solid var(--line); }
  .label { padding:.5rem 1rem; border-bottom:1px solid var(--line); color:var(--dim); font-size:12px; }
  #log { flex:1; overflow-y:auto; padding:.5rem 1rem; }
  .line { padding:.1rem 0; white-space:pre-wrap; word-break:break-word; }
  #stream { padding:.5rem 1rem; border-top:1px solid var(--line); }
  #stream button { margin-left:.6rem; padding:.1rem .6rem; }
  form { display:flex; gap:.5rem; padding:.75rem 1rem; border-top:1px solid var(--line); }
  input { flex:1; font:inherit; padding:.4rem .6rem; background:transparent; color:var(--fg); border:1px solid var(--line); border-radius:4px; }
  button { font:inherit; padding:.4rem .9rem; border:1px solid var(--accent); background:var(--accent); color:#fff; border-radius:4px; cursor:pointer; }
  #surface { flex:1; position:relative; overflow:hidden; cursor:crosshair; }
  .cursor { position:absolute; top:0; left:0; width:10px; height:10px; border-radius:50%; background:var(--accent); transition:transform 60ms linear; pointer-events:none; }
  .cursor::after { content:attr(data-name); position:absolute; left:14px; top:-2px; font-size:11px; color:var(--dim); white-space:nowrap; }
</style>
</head>
<body>
<div id="root"></div>
<script type="module" src="/src/main.tsx"></script>
</body>
</html>
```

Vite serves the page on its own port, and the page needs the certificate hash the server
command publishes on its port. One proxied path connects them:

```ts file=vite.config.ts
import { defineConfig } from 'vite'

export default defineConfig({
  // `transport-io dev` publishes the certificate hash on 3000; the page on 5173 reads it there.
  server: { proxy: { '/.well-known/transport-io-dev': 'http://localhost:3000' } },
})
```

The entry mounts the app:

```tsx file=src/main.tsx
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { App } from './App.tsx'

createRoot(document.getElementById('root') as HTMLElement).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
```

The app builds one client and hands it to the provider. `new Client` rather than a connected
client, so the provider can connect it and the page can show `connecting` before it is; in
`useState`, so there is one per mounted tree and never one at module level.

```tsx file=src/App.tsx
import { TransportProvider } from '@transport-io/react'
import { useState } from 'react'
import { Client } from 'transport-io'
import { connectDev } from 'transport-io/dev-transport'
import { type ChatMap, contract } from '../contract.ts'
import { Chat } from './Chat.tsx'

export function App() {
  // new Client, so the provider can connect it. One per mounted tree, never at module level.
  const [client] = useState(
    () => new Client<ChatMap>({ contract, connect: () => connectDev() }),
  )
  return (
    <TransportProvider client={client}>
      <Chat />
    </TransportProvider>
  )
}
```

The hooks are bound to the map once:

```ts file=src/api.ts
import { createHooks } from '@transport-io/react'
import type { ChatMap } from '../contract.ts'

export const api = createHooks<ChatMap>()
```

And the chat itself. `useConnection()` is the snapshot: `status`, and `lastError` with its
code and remedy. `useEvent` receives an event for as long as the component is mounted.
`useClient()` is the client, for `emit`.

```tsx file=src/Chat.tsx
import { type FormEvent, useState } from 'react'
import { api } from './api.ts'

const me = `guest-${Math.random().toString(36).slice(2, 6)}`

interface Line {
  id: number
  from: string
  body: string
  at: number
}

interface Point {
  x: number
  y: number
}

export function Chat() {
  const { status, lastError } = api.useConnection()

  return (
    <>
      <header>
        <h1>transport-io</h1>
        <span className="meta">
          status{' '}
          <span id="status" data-state={status}>
            {status}
          </span>
        </span>
        {lastError !== null && (
          <span className="meta" id="error">
            {lastError.code}: {lastError.remedy}
          </span>
        )}
      </header>
      <main>
        <section>
          <div className="label">
            chat, <strong>reliable</strong>.
          </div>
          <Log />
          <Composer />
        </section>
        <section>
          <div className="label">
            cursors, <strong>unreliable</strong>. Move your pointer; the other window sees it.
          </div>
          <Surface />
        </section>
      </main>
    </>
  )
}

function Log() {
  const [lines, setLines] = useState<Line[]>([])
  api.useEvent('chat', (msg) => setLines((prev) => [...prev, { ...msg, id: prev.length }]))

  return (
    <div id="log">
      {lines.map((l) => (
        <div className="line" key={l.id}>
          {new Date(l.at).toLocaleTimeString()} {l.from}: {l.body}
        </div>
      ))}
    </div>
  )
}

function Composer() {
  const client = api.useClient()
  const [body, setBody] = useState('')

  const submit = (e: FormEvent) => {
    e.preventDefault()
    const text = body.trim()
    setBody('')
    if (text.length === 0) return
    client.emit('chat', { from: me, body: text, at: Date.now() })
  }

  return (
    <form id="composer" onSubmit={submit}>
      <input
        id="body"
        value={body}
        onChange={(e) => setBody(e.target.value)}
        placeholder="say something"
        autoComplete="off"
      />
      <button type="submit">send</button>
    </form>
  )
}

function Surface() {
  const client = api.useClient()
  const [cursors, setCursors] = useState<Record<string, Point>>({})
  api.useEvent('cursor', ({ from, x, y }) =>
    setCursors((prev) => ({ ...prev, [from]: { x, y } })),
  )

  return (
    <div
      id="surface"
      onPointerMove={(e) => {
        const r = e.currentTarget.getBoundingClientRect()
        client.emit('cursor', {
          from: me,
          x: Math.round(e.clientX - r.left),
          y: Math.round(e.clientY - r.top),
        })
      }}
    >
      {Object.entries(cursors).map(([from, { x, y }]) => (
        <div
          className="cursor"
          key={from}
          data-name={from}
          style={{ transform: `translate(${x}px, ${y}px)` }}
        />
      ))}
    </div>
  )
}
```

In a second terminal:

```bash
npm run dev
```

Open `http://localhost:5173` in two windows, in Chrome or Firefox. Type in one; it appears in
both, with a time and a guest name. Move the pointer over the right half of one window; a dot
follows it in the other. Some of those moves never arrive, and that is the unreliable lane
doing what it declared.

`npm run build` then `npm start` serves the built page from the server command instead, on
one port, with no proxy.

## 6. A name from a call

A call is a request with one answer, on its own QUIC stream. Add one to the contract:

```diff lang="ts" file=contract.ts
-import { defineContract, type MapOf, reliable, unreliable } from 'transport-io'
+import { defineContract, type MapOf, reliable, rpc, unreliable } from 'transport-io'
 import { z } from 'zod'
 
 export const contract = defineContract({
   chat: reliable(z.object({ from: z.string(), body: z.string().max(2000), at: z.number() })),
   cursor: unreliable(z.object({ from: z.string(), x: z.number(), y: z.number() })),
+  setName: rpc(
+    z.object({ name: z.string() }),
+    z.object({ accepted: z.boolean(), name: z.string() }),
+  ),
 })
 
 export interface ChatMap extends MapOf<typeof contract> {}
```

<details>
<summary>contract.ts after this step</summary>

```ts file=contract.ts ref
import { defineContract, type MapOf, reliable, rpc, unreliable } from 'transport-io'
import { z } from 'zod'

export const contract = defineContract({
  chat: reliable(z.object({ from: z.string(), body: z.string().max(2000), at: z.number() })),
  cursor: unreliable(z.object({ from: z.string(), x: z.number(), y: z.number() })),
  setName: rpc(
    z.object({ name: z.string() }),
    z.object({ accepted: z.boolean(), name: z.string() }),
  ),
})

export interface ChatMap extends MapOf<typeof contract> {}
```

</details>

`rpc` declares the payload and the answer. Handle it on the server:

```diff lang="ts" file=server.node.ts
 
 const ROOM = 'lobby'
 const server = createServer<ChatMap>({ contract })
+
+server.handle('setName', async ({ name }) => {
+  const trimmed = name.trim().slice(0, 24)
+  return trimmed.length === 0
+    ? { accepted: false, name: '' }
+    : { accepted: true, name: trimmed }
+})
 
 server.onSession((peer) => {
   void peer.join(ROOM)
```

<details>
<summary>server.node.ts after this step</summary>

```ts file=server.node.ts ref
/** The server. Started by `transport-io dev`, which mints the certificate. Node only. */
import { createServer } from 'transport-io'
import { listenDev } from 'transport-io/node-transport'
import { type ChatMap, contract } from './contract.ts'

const ROOM = 'lobby'
const server = createServer<ChatMap>({ contract })

server.handle('setName', async ({ name }) => {
  const trimmed = name.trim().slice(0, 24)
  return trimmed.length === 0
    ? { accepted: false, name: '' }
    : { accepted: true, name: trimmed }
})

server.onSession((peer) => {
  void peer.join(ROOM)
  peer.on('chat', (msg) => {
    // To everyone, the sender included.
    void server.to(ROOM).emit('chat', { ...msg, at: Date.now() })
  })
  peer.on('cursor', (pos) => {
    void server.to(ROOM).except(peer.id).emit('cursor', pos)
  })
})

await server.listen(await listenDev())
console.log('chat server ready')
```

</details>

And ask for it from the page. `useCall` returns the call and its state, and the state's
`data` is the answer, typed from the contract. The effect asks again on every connect,
because a reconnect is a new session. The name then reaches the composer and the surface as a
prop, and both wait for it.

```diff lang="tsx" file=src/Chat.tsx
-import { type FormEvent, useState } from 'react'
+import { type FormEvent, useEffect, useState } from 'react'
 import { api } from './api.ts'
 
 const me = `guest-${Math.random().toString(36).slice(2, 6)}`
```

```diff lang="tsx" file=src/Chat.tsx
 
 export function Chat() {
   const { status, lastError } = api.useConnection()
+  const [setName, named] = api.useCall('setName')
+
+  // On every connect: a reconnect is a new session.
+  useEffect(() => {
+    if (status === 'connected') void setName({ name: me })
+  }, [status, setName])
+
+  const name = named.status === 'success' && named.data.accepted ? named.data.name : null
 
   return (
     <>
```

```diff lang="tsx" file=src/Chat.tsx
           <span id="status" data-state={status}>
             {status}
           </span>
+        </span>
+        <span className="meta">
+          you are <span id="me">{name ?? '…'}</span>
         </span>
         {lastError !== null && (
           <span className="meta" id="error">
```

```diff lang="tsx" file=src/Chat.tsx
             chat, <strong>reliable</strong>.
           </div>
           <Log />
-          <Composer />
+          <Composer name={name} />
         </section>
         <section>
           <div className="label">
             cursors, <strong>unreliable</strong>. Move your pointer; the other window sees it.
           </div>
-          <Surface />
+          <Surface name={name} />
         </section>
       </main>
     </>
```

```diff lang="tsx" file=src/Chat.tsx
   )
 }
 
-function Composer() {
+function Composer({ name }: { name: string | null }) {
   const client = api.useClient()
   const [body, setBody] = useState('')
 
```

```diff lang="tsx" file=src/Chat.tsx
     e.preventDefault()
     const text = body.trim()
     setBody('')
-    if (text.length === 0) return
-    client.emit('chat', { from: me, body: text, at: Date.now() })
+    if (text.length === 0 || name === null) return
+    client.emit('chat', { from: name, body: text, at: Date.now() })
   }
 
   return (
```

```diff lang="tsx" file=src/Chat.tsx
         id="body"
         value={body}
         onChange={(e) => setBody(e.target.value)}
-        placeholder="say something"
+        placeholder={name === null ? 'connecting' : 'say something'}
         autoComplete="off"
+        disabled={name === null}
       />
       <button type="submit">send</button>
     </form>
   )
 }
 
-function Surface() {
+function Surface({ name }: { name: string | null }) {
   const client = api.useClient()
   const [cursors, setCursors] = useState<Record<string, Point>>({})
   api.useEvent('cursor', ({ from, x, y }) =>
```

```diff lang="tsx" file=src/Chat.tsx
     <div
       id="surface"
       onPointerMove={(e) => {
+        if (name === null) return
         const r = e.currentTarget.getBoundingClientRect()
         client.emit('cursor', {
-          from: me,
+          from: name,
           x: Math.round(e.clientX - r.left),
           y: Math.round(e.clientY - r.top),
         })
```

<details>
<summary>src/Chat.tsx after this step</summary>

```tsx file=src/Chat.tsx ref
import { type FormEvent, useEffect, useState } from 'react'
import { api } from './api.ts'

const me = `guest-${Math.random().toString(36).slice(2, 6)}`

interface Line {
  id: number
  from: string
  body: string
  at: number
}

interface Point {
  x: number
  y: number
}

export function Chat() {
  const { status, lastError } = api.useConnection()
  const [setName, named] = api.useCall('setName')

  // On every connect: a reconnect is a new session.
  useEffect(() => {
    if (status === 'connected') void setName({ name: me })
  }, [status, setName])

  const name = named.status === 'success' && named.data.accepted ? named.data.name : null

  return (
    <>
      <header>
        <h1>transport-io</h1>
        <span className="meta">
          status{' '}
          <span id="status" data-state={status}>
            {status}
          </span>
        </span>
        <span className="meta">
          you are <span id="me">{name ?? '…'}</span>
        </span>
        {lastError !== null && (
          <span className="meta" id="error">
            {lastError.code}: {lastError.remedy}
          </span>
        )}
      </header>
      <main>
        <section>
          <div className="label">
            chat, <strong>reliable</strong>.
          </div>
          <Log />
          <Composer name={name} />
        </section>
        <section>
          <div className="label">
            cursors, <strong>unreliable</strong>. Move your pointer; the other window sees it.
          </div>
          <Surface name={name} />
        </section>
      </main>
    </>
  )
}

function Log() {
  const [lines, setLines] = useState<Line[]>([])
  api.useEvent('chat', (msg) => setLines((prev) => [...prev, { ...msg, id: prev.length }]))

  return (
    <div id="log">
      {lines.map((l) => (
        <div className="line" key={l.id}>
          {new Date(l.at).toLocaleTimeString()} {l.from}: {l.body}
        </div>
      ))}
    </div>
  )
}

function Composer({ name }: { name: string | null }) {
  const client = api.useClient()
  const [body, setBody] = useState('')

  const submit = (e: FormEvent) => {
    e.preventDefault()
    const text = body.trim()
    setBody('')
    if (text.length === 0 || name === null) return
    client.emit('chat', { from: name, body: text, at: Date.now() })
  }

  return (
    <form id="composer" onSubmit={submit}>
      <input
        id="body"
        value={body}
        onChange={(e) => setBody(e.target.value)}
        placeholder={name === null ? 'connecting' : 'say something'}
        autoComplete="off"
        disabled={name === null}
      />
      <button type="submit">send</button>
    </form>
  )
}

function Surface({ name }: { name: string | null }) {
  const client = api.useClient()
  const [cursors, setCursors] = useState<Record<string, Point>>({})
  api.useEvent('cursor', ({ from, x, y }) =>
    setCursors((prev) => ({ ...prev, [from]: { x, y } })),
  )

  return (
    <div
      id="surface"
      onPointerMove={(e) => {
        if (name === null) return
        const r = e.currentTarget.getBoundingClientRect()
        client.emit('cursor', {
          from: name,
          x: Math.round(e.clientX - r.left),
          y: Math.round(e.clientY - r.top),
        })
      }}
    >
      {Object.entries(cursors).map(([from, { x, y }]) => (
        <div
          className="cursor"
          key={from}
          data-name={from}
          style={{ transform: `translate(${x}px, ${y}px)` }}
        />
      ))}
    </div>
  )
}
```

</details>

Both terminals reload on save. Each window now says `you are guest-…` from the server's
answer, and the name on every message is the one the server accepted.

## 7. A reply that streams

A streaming event answers with a sequence instead of a value. Add `say`:

```diff lang="ts" file=contract.ts
-import { defineContract, type MapOf, reliable, rpc, unreliable } from 'transport-io'
+import { defineContract, type MapOf, reliable, rpc, streaming, unreliable } from 'transport-io'
 import { z } from 'zod'
 
 export const contract = defineContract({
   chat: reliable(z.object({ from: z.string(), body: z.string().max(2000), at: z.number() })),
   cursor: unreliable(z.object({ from: z.string(), x: z.number(), y: z.number() })),
+  // Echoes the text one word at a time.
+  say: streaming(z.object({ text: z.string().max(500) }), z.string()),
   setName: rpc(
     z.object({ name: z.string() }),
     z.object({ accepted: z.boolean(), name: z.string() }),
```

<details>
<summary>contract.ts after this step</summary>

```ts file=contract.ts ref
import { defineContract, type MapOf, reliable, rpc, streaming, unreliable } from 'transport-io'
import { z } from 'zod'

export const contract = defineContract({
  chat: reliable(z.object({ from: z.string(), body: z.string().max(2000), at: z.number() })),
  cursor: unreliable(z.object({ from: z.string(), x: z.number(), y: z.number() })),
  // Echoes the text one word at a time.
  say: streaming(z.object({ text: z.string().max(500) }), z.string()),
  setName: rpc(
    z.object({ name: z.string() }),
    z.object({ accepted: z.boolean(), name: z.string() }),
  ),
})

export interface ChatMap extends MapOf<typeof contract> {}
```

</details>

The handler is an async generator. Each `yield` is one frame on the stream, and the
generator runs at most 32 frames ahead of what the page has taken:

```diff lang="ts" file=server.node.ts
     : { accepted: true, name: trimmed }
 })
 
+server.handle('say', async function* ({ text }) {
+  for (const word of text.split(/\s+/).filter(Boolean)) {
+    await new Promise((r) => setTimeout(r, 80))
+    yield word
+  }
+})
+
 server.onSession((peer) => {
   void peer.join(ROOM)
   peer.on('chat', (msg) => {
```

<details>
<summary>server.node.ts after this step</summary>

```ts file=server.node.ts ref
/** The server. Started by `transport-io dev`, which mints the certificate. Node only. */
import { createServer } from 'transport-io'
import { listenDev } from 'transport-io/node-transport'
import { type ChatMap, contract } from './contract.ts'

const ROOM = 'lobby'
const server = createServer<ChatMap>({ contract })

server.handle('setName', async ({ name }) => {
  const trimmed = name.trim().slice(0, 24)
  return trimmed.length === 0
    ? { accepted: false, name: '' }
    : { accepted: true, name: trimmed }
})

server.handle('say', async function* ({ text }) {
  for (const word of text.split(/\s+/).filter(Boolean)) {
    await new Promise((r) => setTimeout(r, 80))
    yield word
  }
})

server.onSession((peer) => {
  void peer.join(ROOM)
  peer.on('chat', (msg) => {
    // To everyone, the sender included.
    void server.to(ROOM).emit('chat', { ...msg, at: Date.now() })
  })
  peer.on('cursor', (pos) => {
    void server.to(ROOM).except(peer.id).emit('cursor', pos)
  })
})

await server.listen(await listenDev())
console.log('chat server ready')
```

</details>

`useStream` returns the call, the stream's state and a stop. The state carries the elements
so far and a status, and the stop resets the stream: the loop ends, and the server's
generator ends where it stands.

```diff lang="tsx" file=src/Chat.tsx
       <main>
         <section>
           <div className="label">
-            chat, <strong>reliable</strong>.
+            chat, <strong>reliable</strong>. Type <code>/say some words</code> for a stream.
           </div>
           <Log />
           <Composer name={name} />
```

```diff lang="tsx" file=src/Chat.tsx
 
 function Composer({ name }: { name: string | null }) {
   const client = api.useClient()
+  const [say, stream, stop] = api.useStream('say')
   const [body, setBody] = useState('')
 
   const submit = (e: FormEvent) => {
```

```diff lang="tsx" file=src/Chat.tsx
     const text = body.trim()
     setBody('')
     if (text.length === 0 || name === null) return
-    client.emit('chat', { from: name, body: text, at: Date.now() })
+    if (text.startsWith('/say ')) say({ text: text.slice(5) })
+    else client.emit('chat', { from: name, body: text, at: Date.now() })
   }
 
   return (
-    <form id="composer" onSubmit={submit}>
-      <input
-        id="body"
-        value={body}
-        onChange={(e) => setBody(e.target.value)}
-        placeholder={name === null ? 'connecting' : 'say something'}
-        autoComplete="off"
-        disabled={name === null}
-      />
-      <button type="submit">send</button>
-    </form>
+    <>
+      {stream.status !== 'idle' && (
+        <div id="stream" className="line" data-state={stream.status}>
+          stream: {stream.elements.join(' ')}
+          {stream.status === 'streaming' && (
+            <button id="stop" type="button" onClick={stop}>
+              stop
+            </button>
+          )}
+          {stream.status === 'error' && <span> {stream.error.code}</span>}
+        </div>
+      )}
+      <form id="composer" onSubmit={submit}>
+        <input
+          id="body"
+          value={body}
+          onChange={(e) => setBody(e.target.value)}
+          placeholder={name === null ? 'connecting' : 'say something'}
+          autoComplete="off"
+          disabled={name === null}
+        />
+        <button type="submit">send</button>
+      </form>
+    </>
   )
 }
 
```

<details>
<summary>src/Chat.tsx after this step</summary>

```tsx file=src/Chat.tsx ref
import { type FormEvent, useEffect, useState } from 'react'
import { api } from './api.ts'

const me = `guest-${Math.random().toString(36).slice(2, 6)}`

interface Line {
  id: number
  from: string
  body: string
  at: number
}

interface Point {
  x: number
  y: number
}

export function Chat() {
  const { status, lastError } = api.useConnection()
  const [setName, named] = api.useCall('setName')

  // On every connect: a reconnect is a new session.
  useEffect(() => {
    if (status === 'connected') void setName({ name: me })
  }, [status, setName])

  const name = named.status === 'success' && named.data.accepted ? named.data.name : null

  return (
    <>
      <header>
        <h1>transport-io</h1>
        <span className="meta">
          status{' '}
          <span id="status" data-state={status}>
            {status}
          </span>
        </span>
        <span className="meta">
          you are <span id="me">{name ?? '…'}</span>
        </span>
        {lastError !== null && (
          <span className="meta" id="error">
            {lastError.code}: {lastError.remedy}
          </span>
        )}
      </header>
      <main>
        <section>
          <div className="label">
            chat, <strong>reliable</strong>. Type <code>/say some words</code> for a stream.
          </div>
          <Log />
          <Composer name={name} />
        </section>
        <section>
          <div className="label">
            cursors, <strong>unreliable</strong>. Move your pointer; the other window sees it.
          </div>
          <Surface name={name} />
        </section>
      </main>
    </>
  )
}

function Log() {
  const [lines, setLines] = useState<Line[]>([])
  api.useEvent('chat', (msg) => setLines((prev) => [...prev, { ...msg, id: prev.length }]))

  return (
    <div id="log">
      {lines.map((l) => (
        <div className="line" key={l.id}>
          {new Date(l.at).toLocaleTimeString()} {l.from}: {l.body}
        </div>
      ))}
    </div>
  )
}

function Composer({ name }: { name: string | null }) {
  const client = api.useClient()
  const [say, stream, stop] = api.useStream('say')
  const [body, setBody] = useState('')

  const submit = (e: FormEvent) => {
    e.preventDefault()
    const text = body.trim()
    setBody('')
    if (text.length === 0 || name === null) return
    if (text.startsWith('/say ')) say({ text: text.slice(5) })
    else client.emit('chat', { from: name, body: text, at: Date.now() })
  }

  return (
    <>
      {stream.status !== 'idle' && (
        <div id="stream" className="line" data-state={stream.status}>
          stream: {stream.elements.join(' ')}
          {stream.status === 'streaming' && (
            <button id="stop" type="button" onClick={stop}>
              stop
            </button>
          )}
          {stream.status === 'error' && <span> {stream.error.code}</span>}
        </div>
      )}
      <form id="composer" onSubmit={submit}>
        <input
          id="body"
          value={body}
          onChange={(e) => setBody(e.target.value)}
          placeholder={name === null ? 'connecting' : 'say something'}
          autoComplete="off"
          disabled={name === null}
        />
        <button type="submit">send</button>
      </form>
    </>
  )
}

function Surface({ name }: { name: string | null }) {
  const client = api.useClient()
  const [cursors, setCursors] = useState<Record<string, Point>>({})
  api.useEvent('cursor', ({ from, x, y }) =>
    setCursors((prev) => ({ ...prev, [from]: { x, y } })),
  )

  return (
    <div
      id="surface"
      onPointerMove={(e) => {
        if (name === null) return
        const r = e.currentTarget.getBoundingClientRect()
        client.emit('cursor', {
          from: name,
          x: Math.round(e.clientX - r.left),
          y: Math.round(e.clientY - r.top),
        })
      }}
    >
      {Object.entries(cursors).map(([from, { x, y }]) => (
        <div
          className="cursor"
          key={from}
          data-name={from}
          style={{ transform: `translate(${x}px, ${y}px)` }}
        />
      ))}
    </div>
  )
}
```

</details>

Type `/say one word at a time` and watch the line grow in place, with a stop button beside
it while it runs.

## 8. Watch the unreliable lane lose frames

The last event lets a window ask the server to drop a share of that window's own cursor
frames before broadcasting them, so the other window can watch the loss happen while chat
keeps arriving one for one.

```diff lang="ts" file=contract.ts
     z.object({ name: z.string() }),
     z.object({ accepted: z.boolean(), name: z.string() }),
   ),
+  // The server drops this share of the caller's cursor frames before broadcasting.
+  setLoss: rpc(z.object({ percent: z.number() }), z.object({ percent: z.number() })),
 })
 
 export interface ChatMap extends MapOf<typeof contract> {}
```

<details>
<summary>contract.ts after this step</summary>

```ts file=contract.ts ref
import { defineContract, type MapOf, reliable, rpc, streaming, unreliable } from 'transport-io'
import { z } from 'zod'

export const contract = defineContract({
  chat: reliable(z.object({ from: z.string(), body: z.string().max(2000), at: z.number() })),
  cursor: unreliable(z.object({ from: z.string(), x: z.number(), y: z.number() })),
  // Echoes the text one word at a time.
  say: streaming(z.object({ text: z.string().max(500) }), z.string()),
  setName: rpc(
    z.object({ name: z.string() }),
    z.object({ accepted: z.boolean(), name: z.string() }),
  ),
  // The server drops this share of the caller's cursor frames before broadcasting.
  setLoss: rpc(z.object({ percent: z.number() }), z.object({ percent: z.number() })),
})

export interface ChatMap extends MapOf<typeof contract> {}
```

</details>

```diff lang="ts" file=server.node.ts
 /** The server. Started by `transport-io dev`, which mints the certificate. Node only. */
-import { createServer } from 'transport-io'
+import { createServer, type ServerPeer } from 'transport-io'
 import { listenDev } from 'transport-io/node-transport'
 import { type ChatMap, contract } from './contract.ts'
 
 const ROOM = 'lobby'
 const server = createServer<ChatMap>({ contract })
+// Keyed by the peer, so the entry goes when the session does.
+const loss = new WeakMap<ServerPeer<ChatMap>, number>()
+
+function clampPercent(n: number) {
+  return Number.isFinite(n) ? Math.min(100, Math.max(0, Math.round(n))) : 0
+}
 
 server.handle('setName', async ({ name }) => {
   const trimmed = name.trim().slice(0, 24)
   return trimmed.length === 0
     ? { accepted: false, name: '' }
     : { accepted: true, name: trimmed }
+})
+
+// Answers with the clamped value, which is what the page shows.
+server.handle('setLoss', async ({ percent }, ctx) => {
+  const p = clampPercent(percent)
+  loss.set(ctx.peer, p / 100)
+  return { percent: p }
 })
 
 server.handle('say', async function* ({ text }) {
```

```diff lang="ts" file=server.node.ts
     void server.to(ROOM).emit('chat', { ...msg, at: Date.now() })
   })
   peer.on('cursor', (pos) => {
+    // Drops the caller's chosen share before broadcasting.
+    const p = loss.get(peer) ?? 0
+    if (p > 0 && Math.random() < p) return
     void server.to(ROOM).except(peer.id).emit('cursor', pos)
   })
 })
```

<details>
<summary>server.node.ts after this step</summary>

```ts file=server.node.ts ref
/** The server. Started by `transport-io dev`, which mints the certificate. Node only. */
import { createServer, type ServerPeer } from 'transport-io'
import { listenDev } from 'transport-io/node-transport'
import { type ChatMap, contract } from './contract.ts'

const ROOM = 'lobby'
const server = createServer<ChatMap>({ contract })
// Keyed by the peer, so the entry goes when the session does.
const loss = new WeakMap<ServerPeer<ChatMap>, number>()

function clampPercent(n: number) {
  return Number.isFinite(n) ? Math.min(100, Math.max(0, Math.round(n))) : 0
}

server.handle('setName', async ({ name }) => {
  const trimmed = name.trim().slice(0, 24)
  return trimmed.length === 0
    ? { accepted: false, name: '' }
    : { accepted: true, name: trimmed }
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
  void peer.join(ROOM)
  peer.on('chat', (msg) => {
    // To everyone, the sender included.
    void server.to(ROOM).emit('chat', { ...msg, at: Date.now() })
  })
  peer.on('cursor', (pos) => {
    // Drops the caller's chosen share before broadcasting.
    const p = loss.get(peer) ?? 0
    if (p > 0 && Math.random() < p) return
    void server.to(ROOM).except(peer.id).emit('cursor', pos)
  })
})

await server.listen(await listenDev())
console.log('chat server ready')
```

</details>

The loss is kept per peer in a `WeakMap`, so it goes when the session does. The handler
answers with the clamped value, which is what the page shows.

Two more components in the header: the counts of what this window has received on each lane,
and the slider, which is `useCall` again.

```diff lang="tsx" file=src/Chat.tsx
         <span className="meta">
           you are <span id="me">{name ?? '…'}</span>
         </span>
+        <Received />
+        <Loss />
         {lastError !== null && (
           <span className="meta" id="error">
             {lastError.code}: {lastError.remedy}
```

```diff lang="tsx" file=src/Chat.tsx
         <section>
           <div className="label">
             cursors, <strong>unreliable</strong>. Move your pointer; the other window sees it.
+            The slider makes the server drop that share of your frames, so the other window
+            watches the loss.
           </div>
           <Surface name={name} />
         </section>
       </main>
     </>
+  )
+}
+
+function Received() {
+  const [chat, setChat] = useState(0)
+  const [cursor, setCursor] = useState(0)
+  api.useEvent('chat', () => setChat((n) => n + 1))
+  api.useEvent('cursor', () => setCursor((n) => n + 1))
+
+  return (
+    <span className="meta">
+      received <span id="rx-chat">{chat}</span> chat · <span id="rx-cursor">{cursor}</span>{' '}
+      cursor
+    </span>
+  )
+}
+
+function Loss() {
+  const [setLoss, loss] = api.useCall('setLoss')
+  // The label shows what the server set, not what the slider asked for.
+  const percent = loss.status === 'success' ? loss.data.percent : 0
+
+  return (
+    <label className="meta" htmlFor="loss">
+      drop <strong id="loss-value">{percent}%</strong> of my cursor frames{' '}
+      <input
+        id="loss"
+        type="range"
+        min={0}
+        max={100}
+        step={10}
+        defaultValue={0}
+        style={{ verticalAlign: 'middle', width: 110 }}
+        onChange={(e) => void setLoss({ percent: Number(e.target.value) })}
+      />
+    </label>
   )
 }
 
```

<details>
<summary>src/Chat.tsx after this step</summary>

```tsx file=src/Chat.tsx ref
import { type FormEvent, useEffect, useState } from 'react'
import { api } from './api.ts'

const me = `guest-${Math.random().toString(36).slice(2, 6)}`

interface Line {
  id: number
  from: string
  body: string
  at: number
}

interface Point {
  x: number
  y: number
}

export function Chat() {
  const { status, lastError } = api.useConnection()
  const [setName, named] = api.useCall('setName')

  // On every connect: a reconnect is a new session.
  useEffect(() => {
    if (status === 'connected') void setName({ name: me })
  }, [status, setName])

  const name = named.status === 'success' && named.data.accepted ? named.data.name : null

  return (
    <>
      <header>
        <h1>transport-io</h1>
        <span className="meta">
          status{' '}
          <span id="status" data-state={status}>
            {status}
          </span>
        </span>
        <span className="meta">
          you are <span id="me">{name ?? '…'}</span>
        </span>
        <Received />
        <Loss />
        {lastError !== null && (
          <span className="meta" id="error">
            {lastError.code}: {lastError.remedy}
          </span>
        )}
      </header>
      <main>
        <section>
          <div className="label">
            chat, <strong>reliable</strong>. Type <code>/say some words</code> for a stream.
          </div>
          <Log />
          <Composer name={name} />
        </section>
        <section>
          <div className="label">
            cursors, <strong>unreliable</strong>. Move your pointer; the other window sees it.
            The slider makes the server drop that share of your frames, so the other window
            watches the loss.
          </div>
          <Surface name={name} />
        </section>
      </main>
    </>
  )
}

function Received() {
  const [chat, setChat] = useState(0)
  const [cursor, setCursor] = useState(0)
  api.useEvent('chat', () => setChat((n) => n + 1))
  api.useEvent('cursor', () => setCursor((n) => n + 1))

  return (
    <span className="meta">
      received <span id="rx-chat">{chat}</span> chat · <span id="rx-cursor">{cursor}</span>{' '}
      cursor
    </span>
  )
}

function Loss() {
  const [setLoss, loss] = api.useCall('setLoss')
  // The label shows what the server set, not what the slider asked for.
  const percent = loss.status === 'success' ? loss.data.percent : 0

  return (
    <label className="meta" htmlFor="loss">
      drop <strong id="loss-value">{percent}%</strong> of my cursor frames{' '}
      <input
        id="loss"
        type="range"
        min={0}
        max={100}
        step={10}
        defaultValue={0}
        style={{ verticalAlign: 'middle', width: 110 }}
        onChange={(e) => void setLoss({ percent: Number(e.target.value) })}
      />
    </label>
  )
}

function Log() {
  const [lines, setLines] = useState<Line[]>([])
  api.useEvent('chat', (msg) => setLines((prev) => [...prev, { ...msg, id: prev.length }]))

  return (
    <div id="log">
      {lines.map((l) => (
        <div className="line" key={l.id}>
          {new Date(l.at).toLocaleTimeString()} {l.from}: {l.body}
        </div>
      ))}
    </div>
  )
}

function Composer({ name }: { name: string | null }) {
  const client = api.useClient()
  const [say, stream, stop] = api.useStream('say')
  const [body, setBody] = useState('')

  const submit = (e: FormEvent) => {
    e.preventDefault()
    const text = body.trim()
    setBody('')
    if (text.length === 0 || name === null) return
    if (text.startsWith('/say ')) say({ text: text.slice(5) })
    else client.emit('chat', { from: name, body: text, at: Date.now() })
  }

  return (
    <>
      {stream.status !== 'idle' && (
        <div id="stream" className="line" data-state={stream.status}>
          stream: {stream.elements.join(' ')}
          {stream.status === 'streaming' && (
            <button id="stop" type="button" onClick={stop}>
              stop
            </button>
          )}
          {stream.status === 'error' && <span> {stream.error.code}</span>}
        </div>
      )}
      <form id="composer" onSubmit={submit}>
        <input
          id="body"
          value={body}
          onChange={(e) => setBody(e.target.value)}
          placeholder={name === null ? 'connecting' : 'say something'}
          autoComplete="off"
          disabled={name === null}
        />
        <button type="submit">send</button>
      </form>
    </>
  )
}

function Surface({ name }: { name: string | null }) {
  const client = api.useClient()
  const [cursors, setCursors] = useState<Record<string, Point>>({})
  api.useEvent('cursor', ({ from, x, y }) =>
    setCursors((prev) => ({ ...prev, [from]: { x, y } })),
  )

  return (
    <div
      id="surface"
      onPointerMove={(e) => {
        if (name === null) return
        const r = e.currentTarget.getBoundingClientRect()
        client.emit('cursor', {
          from: name,
          x: Math.round(e.clientX - r.left),
          y: Math.round(e.clientY - r.top),
        })
      }}
    >
      {Object.entries(cursors).map(([from, { x, y }]) => (
        <div
          className="cursor"
          key={from}
          data-name={from}
          style={{ transform: `translate(${x}px, ${y}px)` }}
        />
      ))}
    </div>
  )
}
```

</details>

Drag the slider in one window and keep moving the pointer: the other window's cursor count
stalls while its chat count does not. That is the whole difference between the two lanes, on
screen.

You have a chat with cursors, in your own project, running. What follows is optional.

## 9. The second page

`examples/chat` in the repository, the same chat with nothing in front of the library, has a
second page that runs two streaming calls at the same time and lets you stop either one. It
is the shortest answer to why this is not a WebSocket, and it is what the screenshot on the
front page shows. Its handler streams a fixed script one token at a time, keeps a count of
how many generations one session is running, and learns from `ctx.signal.aborted` that the
caller stopped it:

```ts excerpt=examples/chat/app.ts
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
```

The scripts are in
[`examples/chat/agents.ts`](https://github.com/transport-io/transport-io/blob/main/examples/chat/agents.ts),
and the page that runs two of them and stops either is
[`examples/chat/web/agents.ts`](https://github.com/transport-io/transport-io/blob/main/examples/chat/web/agents.ts).
[Examples](/examples/) says how to run it.

## Where next

- [The fallback](/guides/fallback/), for browsers without WebTransport and networks that
  block UDP.
- [Certificates](/guides/certificates/), for deploying this with a real certificate.
- [React](/guides/react/), for the rest of the binding.
- [Troubleshooting](/troubleshooting/), for what a failed connection looks like.
