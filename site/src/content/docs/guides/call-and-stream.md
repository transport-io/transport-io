---
title: call() and stream()
description: One value or a sequence, decided in the contract and not at the call site.
---

An event that declares `returns` is **called** and answers with one value. An event that
declares `yields` is **streamed** and answers with a sequence. They are mutually exclusive,
and the choice lives in the contract.

```ts
import { Client, createServer, defineContract, type MapOf, type$ } from 'transport-io'

export const contract = defineContract({
  save: { lane: 'reliable', payload: type$<{ text: string }>(), returns: type$<{ n: number }>() },
  ask:  { lane: 'reliable', payload: type$<{ prompt: string }>(), yields: type$<string>() },
})
export interface AppMap extends MapOf<typeof contract> {}

declare const client: Client<AppMap>
declare const server: ReturnType<typeof createServer<AppMap>>
declare function model(text: string): AsyncIterable<string>
// Shadows the DOM's `prompt()`, which is what a reader's own variable does too.
declare const prompt: string
declare const userStopped: boolean
declare function render(token: string): void
```

`call('ask', …)` does not compile and neither does `stream('save', …)`. At runtime both are
refused with an error naming the method that would have worked.

## Why the contract and not the call site

This is the question that gets asked, and the answer is on the wire rather than in taste.

A handler that yields nothing closes the stream with **zero response frames**. That is byte
for byte what a broken `call()` responder produces. Identical bytes, two meanings: a
protocol error in one shape, a clean empty sequence in the other. The only thing that can
tell them apart is the contract, which both peers exchange at handshake before any response
arrives.

A per-call-site choice would leave someone implementing this protocol in another language
with a case they cannot resolve.

## call()

```ts
const { n } = await client.call('save', { text: 'hello' })
```

Each call opens its own bidirectional stream, so the stream **is** the correlation: no
identifiers, no pending-callback map, no timer per request. A stalled call cannot block
another one.

**There is no default timeout.** A dead peer is detected by the QUIC idle timeout, which
rejects every pending call, so the case a timeout is usually reached for is already handled.
When you want a deadline, say so:

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
server.handle('ask', async function* ({ prompt }, ctx) {
  for await (const token of model(prompt)) {
    ctx.signal.throwIfAborted()
    yield token
  }
})
```

**`break` is the cancel.** Leaving the loop calls the iterator's `return()`, which resets the
QUIC stream, which arrives at the responder as STOP_SENDING, which fires `ctx.signal` and
runs the generator's own `finally`. There is no `.cancel()` because there is nothing for one
to do. An `AbortSignal` does the same thing from outside the loop, which is what a React
effect cleanup will call.

`collect()` takes the whole sequence when you do not want a loop:

```ts
const tokens = await client.stream('ask', { prompt }).collect()
```

## Errors partway through

The consumer already has elements when the handler throws. Those elements stay delivered:
the loop yields what arrived and then throws. You cannot un-yield.

`collect()` **rejects** rather than resolving with the partial, because a partial array
returned as if it were the whole answer is worse than an error. If you want what arrived
before the failure, use the loop, which is the API that can express it.

## The budget

A session allows **256 concurrent streams**, shared by `call()` and `stream()`. The 257th is
refused with `WT_TOO_MANY_STREAMS` and the session stays up.

The unit changed meaning when `stream()` arrived. A call holds its slot for a round trip; a
stream holds one for as long as it runs. Ten concurrent generations occupy ten slots for
minutes at a time, which is fine and well inside the cap. Ten thousand is not, and the
failure is a clean refusal rather than a degradation.
