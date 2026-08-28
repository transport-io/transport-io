---
'transport-io': minor
---

Contract helpers: `reliable`, `unreliable`, `rpc` and `streaming`. Each takes a type argument
or a Standard Schema, and `rpc` and `streaming` are reliable by construction, so an
unreliable event with a response is no longer expressible. The object literal keeps working
and mixes with them; `id` is reached by spreading.

`defineContract` now rejects an event whose payload infers `unknown`, with an error naming
the event. `reliable()` with no type argument and no schema used to compile and accept
anything thereafter. Write `reliable<any>()` where a payload is deliberately untyped.
