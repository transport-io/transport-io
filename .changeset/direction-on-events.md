---
'transport-io': minor
---

`fromServer(reliable<T>())` and `fromClient(unreliable<T>())` say which side sends an
event. The other side's `emit` refuses it in the types, the sender's `on` cannot listen for
it, a caller with no compiler is refused at `emit` as `WT_VALIDATION_FAILED`, and a peer that
sends it the wrong way anyway is dropped and counted in `stats().directionDropped`. `MapOf`
carries the direction as `from`; `SentBy<M, side>` and `ReceivedBy<M, side>` name what each
side may send and receive. A call or a stream takes no direction.
