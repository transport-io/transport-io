---
'transport-io': minor
---

`client.observe(observer, { preview })` reports what a session is doing, which no browser
panel shows for WebTransport: one record for every frame in and out, every call stream opening
and closing, and every drop `stats()` counts, on this session and on each one a reconnect
produces. A record is `{ at, session, kind, dir, lane, event, stream, size, sequence,
preview }`, all numbers and strings: it never references a payload, so an observer that keeps
its records keeps nothing the session would release. `preview: true` adds the first 256
bytes of each payload as a string, to the subscriber that asked and nobody else. A drop is a
second record after the frame's own, named after its counter, `overflow-dropped`,
`stale-dropped`, `stale-received` or `direction-dropped`, and it says which event it was,
which `stats()` cannot. Off unless something subscribes: a client nobody observes pays one
branch per frame, which is not measurable, and about a kilobyte of code, which is now held by
a ceiling on the gzipped browser bundle. `FrameRecord`, `FrameKind`, `FrameObserver`,
`ObserveOptions` and `PREVIEW_MAX_BYTES` are exported.
