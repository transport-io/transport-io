/**
 * The parity suite against the moq transport. One transport per process - see
 * `parity-suite.ts` for why.
 */
import { test } from 'node:test'
import { connectMoq, listenMoq } from './transport/moq.node.ts'
import { randomPort, runParity } from './transport/parity-suite.ts'

// SKIPPED for a now-understood reason: `NapiServer.close()` deadlocks. See D71.
//
// This comment used to be stacked on top of an earlier, stale one that ended "un-skip when
// that is understood". It *is* understood, and following that instruction would hang the
// required integration job for its full timeout on every pull request. A skip reason that
// outlives its own investigation is worse than none: it invites exactly the wrong action.
//
// Root-caused, not guessed. Minimal reproduction with no transport-io involved, kept at
// bench/moq-close-deadlock.node.ts:
//
//   bind -> close()                      -> close() returns, process exits
//   bind -> accept() pending -> close()  -> close() NEVER RETURNS
//
// The suite reaches teardown and hangs on `listener.stop()`, because the sessions loop
// always has an `accept()` outstanding. Every standalone probe missed it by ending with
// `process.exit(0)` instead of stopping the listener.
//
// No clean workaround here: a pending native promise cannot be cancelled, and a server
// that accepts always has one pending. It means no graceful shutdown. See D71.
test.skip('moq: both lanes, a call, an abort and an oversized datagram', {
  timeout: 60_000,
}, async () => {
  await runParity({
    name: 'moq',
    port: randomPort(),
    listen: listenMoq,
    propagatesAbortToHandler: false,
    connect: connectMoq,
  })
})
