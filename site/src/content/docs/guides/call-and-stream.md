---
title: call() and stream()
description: One value or a sequence, decided in the contract.
---

An event that declares `returns` is called and answers with one value. An event that
declares `yields` is streamed and answers with a sequence. An event cannot declare both.

```ts
import { type Client, defineContract, type MapOf, rpc, type Server, streaming } from 'transport-io'

export const contract = defineContract({
  save: rpc<{ text: string }, { n: number }>(),
  ask: streaming<{ prompt: string }, string>(),
})
export interface AppMap extends MapOf<typeof contract> {}


declare const client: Client<AppMap>
declare const server: Server<AppMap>
declare function model(text: string): AsyncIterable<string>
declare function enrich(chunk: string): Promise<string>
// Shadows the DOM's `prompt()`, which is what a reader's own variable does too.
declare const prompt: string
declare const userStopped: boolean
declare function render(token: string): Promise<void>
declare const stopButton: { onclick: () => void }
```

`call('ask', …)` does not compile, and neither does `stream('save', …)`. At runtime both are
refused with an error naming the method that would have worked.

The shape is fixed in the contract because an empty sequence and a broken response are the
same bytes on the wire: zero response frames followed by stream close. A receiver decides
which it is from the event's contract entry, exchanged during the handshake. See ADR 0012
if you want the full argument.

## call()

```ts
const { n } = await client.call('save', { text: 'hello' })
```

Each call opens its own bidirectional stream. The stream is the correlation, so there are no
request identifiers, no pending-callback map and no timer per request. A stalled call does
not block other calls.

There is no default timeout. A dead peer is detected by the QUIC idle timeout, which rejects
every pending call. Pass a signal when you want a deadline:

```ts
await client.call('save', { text: 'hi' }, { signal: AbortSignal.timeout(5_000) })
```

## stream()

```ts
for await (const token of client.stream('ask', { prompt })) {
  render(token)
  if (userStopped) break
}
```

```ts
server.handle('ask', async function* ({ prompt }) {
  for await (const token of model(prompt)) {
    yield token
  }
})
```

Leaving the loop cancels the stream. `break` calls the iterator's `return()`, which resets
the QUIC stream. The responder sees STOP_SENDING. Its `ctx.signal` fires and any `finally`
in the generator runs. Passing an `AbortSignal` to `stream()` has the same effect from
outside the loop, which is what a React effect cleanup would use.

The handler above never checks `ctx.signal`. It does not need to: the responder checks
before asking the generator for another value, so a cancelled stream stops without the
handler repeating that check in every loop. Use `ctx.signal.throwIfAborted()` when a handler
does long work *between* yields, where nothing else can interrupt it:

```ts
server.handle('ask', async function* ({ prompt }, ctx) {
  for await (const chunk of model(prompt)) {
    const expensive = await enrich(chunk) // seconds, perhaps
    ctx.signal.throwIfAborted()
    yield expensive
  }
})
```

### Helpers

```ts
const tokens = await client.stream('ask', { prompt }).toArray()
const first20 = await client.stream('ask', { prompt }).take(20).toArray()

await client.stream('ask', { prompt }).forEach(async (token) => {
  await render(token)
})
```

`toArray()` collects the whole sequence. `take(n)` stops after `n` elements and closes the
stream, the same as `break`. `forEach(fn)` awaits `fn` before pulling the next element, so a
slow callback slows the producer instead of queueing behind it.

`cancel()` stops from outside the loop, which is what a stop button needs:

```ts
const generation = client.stream('ask', { prompt })
stopButton.onclick = () => generation.cancel()
await generation.forEach(render)
```

Cancelling aborts the stream, so the consumer sees `WT_ABORTED`, exactly as it would from an
`AbortSignal`.

These four are named after the TC39 async iterator helpers proposal and behave sequentially.
That proposal is being revised to let `map`, `take` and others run several pulls at once,
which would defeat the credit window, so this library will not follow it there. `cancel()` is
not in the proposal at all.

## Errors partway through

When a handler throws after yielding some elements, the consumer keeps those elements. The
loop yields what arrived, then throws.

`toArray()` rejects and discards the partial result. Use the loop if you need what arrived
before the failure.

## Concurrency

A session allows 256 concurrent streams, shared by `call()` and `stream()`. The 257th is
refused with `WT_TOO_MANY_STREAMS`, and the session stays open.

A call holds its slot for a round trip. A stream holds one for as long as it runs, so ten
concurrent generations occupy ten slots for however many minutes they take. Ten thousand
concurrent streams on one session will be refused.
