/**
 * A DOM for the hook tests, without losing the runtime's streams.
 *
 * React Testing Library needs a DOM and bun has none. `GlobalRegistrator` supplies one, but
 * it also overwrites `ReadableStream`, `WritableStream` and `TransformStream` with happy-dom's
 * own versions, and those are not the WHATWG streams the transport reads: the loopback
 * connection hands core a readable and core calls `getReader()` on it, which is not a
 * function on happy-dom's. The natives are captured first and put back afterwards, so the
 * tests get a DOM and a working transport at once.
 */
import { GlobalRegistrator } from '@happy-dom/global-registrator'

const natives = {
  ReadableStream: globalThis.ReadableStream,
  WritableStream: globalThis.WritableStream,
  TransformStream: globalThis.TransformStream,
} as const

GlobalRegistrator.register()

Object.assign(globalThis, natives)
