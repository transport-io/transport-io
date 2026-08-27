# chat with live cursors

Both lanes in one page, so you can watch the difference.

- **chat** is `lane: 'reliable'` - reliable and ordered. Nothing sent here is ever lost.
- **cursor** is `lane: 'unreliable'` - unreliable. Frames are dropped routinely, which is
  fine: a cursor position is stale the moment the next one exists.
- **setName** is a `call()` - request and response on their own bidirectional stream.
- **say** is a `stream()` - type `/say some words` and the reply arrives one word at a time,
  growing the line in place. One bidirectional stream, many response frames.

The contract in [`contract.ts`](contract.ts) is the only place that says which is which.

## Running it

```bash
bun run cert       # mint a 14-day ECDSA P-256 certificate
bun run build:web  # bundle the browser client
bun run start      # http://localhost:8080
```

Or `bun run dev`, which does all three.

Open **two** windows. Type in one; it appears in both. Move the pointer in
one; the dot moves in the other, and the drop counters in the header climb under load.

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
