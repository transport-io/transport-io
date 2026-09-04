# chat with cursors, in React

The chat from [`../chat`](../chat) on `@transport-io/react`: the provider, `useConnection`,
`useEvent`, `useCall` and `useStream`, under Vite. No state library.

- [`contract.ts`](contract.ts) - the events, shared by the server and the page.
- [`server.node.ts`](server.node.ts) - the server. Runs under Node through `transport-io dev`,
  which mints the certificate.
- [`src/api.ts`](src/api.ts) - the hooks, bound to the map with `createHooks<ChatMap>()`.
- [`src/App.tsx`](src/App.tsx) - the client, built inside `useState` and handed to
  `TransportProvider`.
- [`src/Chat.tsx`](src/Chat.tsx) - connection state, the log, the composer with its stream,
  and the cursor surface.

## Running it

Two terminals.

```bash
npm run server   # transport-io dev: the certificate, the server, the hash on :3000
```

```bash
npm run dev      # vite, on http://localhost:5173
```

Open `http://localhost:5173` in two windows, Chrome or Firefox. Type in one; it appears in
both. `/say some words` streams the reply a word at a time, with a stop button while it runs.
Move the pointer over the right pane; the other window sees it.

`npm run build && npm start` serves the built page from `transport-io dev` on :3000 instead,
which is what the e2e suite runs against.

## Things that will trip you up

**`connectDev()` only works on localhost.** It fetches the certificate hash `transport-io dev`
publishes and refuses any other origin. Anywhere else, `connectBrowser({ url, certificateHash })`
with a certificate you pinned, or a certificate from a CA and no hash.

**Vite proxies one path.** `vite.config.ts` forwards `/.well-known/transport-io-dev` to :3000,
which is how the page on :5173 finds the hash. Change the server port in both places or in
neither.

**Chrome or Firefox only.** Safari cannot talk to this server.
