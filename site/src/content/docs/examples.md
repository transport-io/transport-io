---
title: Examples
description: The two examples in the repository, what each shows, and how to run them.
---

Both live under `examples/` in the repository, and both run through `transport-io dev`,
which mints the certificate. Chrome or Firefox for both.

## chat

[`examples/chat`](https://github.com/transport-io/transport-io/tree/main/examples/chat).
Two pages against one server, with no framework. [The tutorial](/tutorial/chat/) builds it
from an empty directory.

`/` puts both lanes on one screen: chat on the reliable lane, cursors on the unreliable one,
a name assigned by a call, `/say some words` streaming the reply a word at a time, and a
slider that makes the server drop a share of your cursor frames so the other window watches
the unreliable lane lose them while chat arrives one for one.

`/agents.html` runs two streaming calls at once and lets you stop either one. Stopping one
resets its QUIC stream: the server's generator ends where it stood, and the other stream does
not lose a token.

![Two panels streaming tokens at once, one of them stopped, the other still counting](../../assets/two-streams.png)

```bash
cd examples/chat
bun run build:web
npx transport-io dev server.node.ts --static web
```

Open the printed URL in two windows.

- `contract.ts` declares the five events and is the only place that says which lane each is on.
- `app.ts` holds the handlers, attached to whichever server hosts the contract.
- `server.node.ts` is the local server, under the dev command.
- `agents.ts` is the fixed script the second page streams. No model is called.
- `web/` is the two pages and their two entry modules, bundled into `web/dist/`.
- `deploy/` is the design and runbook for running it on a VPS with a real certificate.

## react

[`examples/react`](https://github.com/transport-io/transport-io/tree/main/examples/react).
The same chat on `@transport-io/react`, under Vite: the provider, `useConnection`,
`useEvent`, `useCall` and `useStream`, with no state library. The contract's payloads are zod
schemas, so every inbound message is validated on arrival.

Two terminals:

```bash
cd examples/react
npm run server
```

```bash
npm run dev
```

Open `http://localhost:5173` in two windows. Vite proxies `/.well-known/transport-io-dev` to
the server's port, which is how the page finds the certificate hash. `npm run build` then
`npm start` serves the built page from the dev command instead.

- `contract.ts` is the events, shared by the server and the page.
- `server.node.ts` is the server, under the dev command.
- `src/api.ts` binds the hooks to the map with `createHooks<ChatMap>()`.
- `src/App.tsx` builds the client inside `useState` and hands it to `TransportProvider`.
- `src/Chat.tsx` is the connection state, the log, the composer with its stream, and the
  cursor surface.
