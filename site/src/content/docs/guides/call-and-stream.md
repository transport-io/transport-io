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
declare function render(token: string): Promise<void>
declare const stopButton: { onclick: () => void }
```

`call('ask', …)` does not compile, and neither does `stream('save', …)`. At runtime both are
refused with an error naming the method that would have worked.

The shape is fixed in the contract and cannot be chosen per call (ADR 0012).

## call()

```ts
const { n } = await client.call('save', { text: 'hello' })
```

Each call opens its own bidirectional stream, so a stalled call does not block other calls.

There is no default timeout. A dead peer is detected by the QUIC idle timeout, which rejects
every pending call. Pass a signal when you want a deadline:

```ts
await client.call('save', { text: 'hi' }, { signal: AbortSignal.timeout(5_000) })
```

## stream()

```ts
for await (const token of client.stream('ask', { prompt })) {
  render(token)
}
```

```ts
server.handle('ask', async function* ({ prompt }) {
  for await (const token of model(prompt)) {
    yield token
  }
})
```

The loop ends when the server stops. That is what streaming is: no count, no `break`.

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

## Stopping early

Three ways, and each one is a QUIC stream reset: the responder's `ctx.signal` fires and any
`finally` in the generator runs, so the server stops producing when you stop reading.

**`break`**, when something inside the loop decides. Here the loop has what it came for:

```ts
let text = ''
for await (const token of client.stream('ask', { prompt: 'yes or no?' })) {
  text += token
  if (/\b(yes|no)\b/i.test(text)) break
}
```

**`cancel()`**, when the decision comes from outside the loop. That is a stop button, and it
is the case `break` cannot serve:

```ts
const generation = client.stream('ask', { prompt })
stopButton.onclick = () => generation.cancel()
await generation.forEach(render)
```

**An `AbortSignal`**, for a deadline:

```ts
for await (const token of client.stream('ask', { prompt }, { signal: AbortSignal.timeout(5_000) })) {
  render(token)
}
```

A stream stopped by `cancel()` or by a signal ends with `WT_ABORTED` in the loop. One stopped
by `break` just ends. `return` and `throw` out of the loop body do exactly what `break` does:
the iterator is closed, the stream is reset, and the server stops. A function that bails out
mid-stream does not leave a generator running behind it. Measured, not assumed:
`stream.test.ts` holds one test for each of the three.

### Helpers

```ts
const tokens = await client.stream('ask', { prompt }).toArray()

await client.stream('ask', { prompt }).forEach(async (token) => {
  await render(token)
})

const sample = await client.stream('ask', { prompt }).take(5).toArray()
```

`toArray()` collects the whole sequence. `forEach(fn)` awaits `fn` before pulling the next
element, so a slow callback slows the producer instead of queueing behind it. `take(n)` is
for the first `n` of a feed that would otherwise not end, and closes the stream there; it is
not how a token stream ends, because a token stream ends when the server stops.

These behave sequentially, and `cancel()` is this library's own (D99).

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
