---
'transport-io': minor
---

`stream()` gains `take(n)`, `forEach(fn)`, `toArray()` and `cancel()`, and `collect()` is
renamed to `toArray()`.

`take` closes the stream at its limit, the same as `break`. `forEach` awaits its callback
before pulling the next element, so a slow consumer slows the producer. `cancel()` stops from
outside the loop, where `break` cannot reach, and the consumer sees `WT_ABORTED`.

The names follow the TC39 async iterator helpers proposal, the behaviour is sequential, and
it will stay that way: the proposal is being revised to let helpers run several pulls at
once, which would defeat the credit window. `map` and `filter` are not shipped, and `cancel`
is not in the proposal. See D99.
