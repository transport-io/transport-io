# chat, cursors, and two streams at once

Two pages against one server.

- **`/`** puts both lanes in one screen, so the difference between them is something you
  watch rather than something you are told.
- **`/agents.html`** runs two streaming calls at the same time and lets you stop either one.
  It is the shortest answer to why this is not a WebSocket.

Five events carry all of it:

- **chat** is `reliable()` - reliable and ordered. Nothing sent here is ever lost.
- **cursor** is `unreliable()` - frames are dropped routinely, which is fine: a cursor
  position is stale the moment the next one exists.
- **setName** is `rpc()` - request and response on their own bidirectional stream, consumed
  with `call()`.
- **say** is `streaming()` - type `/say some words` and the reply arrives one word at a time,
  growing the line in place. One bidirectional stream, many response frames, consumed with
  `stream()`.
- **generate** is `streaming()` too, and the agents page runs two of them concurrently.

The contract in [`contract.ts`](contract.ts) is the only place that says which is which.
`ChatMap` is passed once at each end: `createServer<ChatMap>` in `server.node.ts` and
`new Client<ChatMap>` in `web/main.ts`.

## Running it

```bash
bun run cert       # mint a 14-day ECDSA P-256 certificate
bun run build:web  # bundle the browser clients
bun run start      # http://localhost:8080
```

Or `bun run dev`, which does all three.

Open **two** windows on `/`. Type in one; it appears in both. Move the pointer in
one; the dot moves in the other, and the drop counters in the header climb under load.

## Two streams at once

Open `/agents.html`. Two panels start generating immediately, each from its own
`stream('generate', ...)` call, and each call gets its own bidirectional QUIC stream inside
the one session.

Press **stop** under either one. Three things happen and all three are visible:

- The panel you stopped freezes on the token it was on. Its state reads `stopped`.
- **open streams** in the header goes from 2 to 1.
- The other panel gains a counter reading `+N since agent-a stopped`, and that number climbs
  from zero while the panel beside it sits frozen. Its rate does not dip.

The server half is in the terminal you started it from. Stopping a panel resets that QUIC
stream, which fires `ctx.signal` in the responder and returns its generator, so the server
prints something like `generate agent-a: cancelled after 21 tokens` and stops producing. It is not a
message the client sends and then hopes is honoured; the transport carries it, and the
generator ends where it stood.

The tokens are generated on the server from a fixed script in [`agents.ts`](agents.ts). **No
model is called** and nothing leaves the machine. What is real is everything underneath: QUIC
over UDP, a pinned certificate, two live streams that know nothing about each other. Pacing
is a function of the token index rather than a random source, so two runs of the page are
identical, which is what makes the page recordable.

## Things that will trip you up

**Chrome or Firefox only.** Safari 26.4 ships WebTransport and still cannot talk to a
quiche-backed server: it waits for session-level flow-control SETTINGS that the underlying
QUIC library does not send. Feature detection will report support and the connection will
establish before failing, which is why the client raises `WT_HANDSHAKE_TIMEOUT` with an
explanation rather than hanging.

**The certificate expires in 14 days.** That is not our choice - a pinned certificate is
capped at 14 days total validity, must be ECDSA (P-256, P-384 or Ed25519), and must be
hashed with SHA-256. Re-run `bun run cert` when it lapses.

**The page is served over plain HTTP on purpose.** `http://localhost` is a trustworthy
origin, so it gets a secure context for free; only the WebTransport endpoint on 4433 needs
a certificate.

**Two ports, two servers.** 8080 is an ordinary HTTP server for the page. 4433 is QUIC over
UDP. If you are running this somewhere that does not route UDP to your process, nothing
will connect - that requirement is in the root README and it is the first thing to check.

## What to look at in the code

`server.node.ts` broadcasts chat to the whole room including the sender, so everyone sees
the same order; and broadcasts cursors with `.except(peer.id)`, because you already know
where your own pointer is.

`web/main.ts` uses `subscribe`/`getSnapshot` rather than a pile of events - the same two
methods a React binding would hand to `useSyncExternalStore`.

`web/agents.ts` is the whole two-stream demonstration and there is no framing code in it, no
correlation identifier and no pending map. Two `stream()` calls, two `for await` loops, and
`cancel()` for stopping from outside a loop where `break` cannot reach. The panel that keeps
running is not handled anywhere: it keeps running because nothing connects the two.
