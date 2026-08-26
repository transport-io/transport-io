# ADR 0006 — Node for the transport, Bun for everything else

**Status:** accepted · **Decision:** D14

## Decision

- **Node** runs anything that loads the native QUIC transport: the session host,
  integration tests, the end-to-end server process, the example app.
- **Bun** runs everything that does not: typecheck, lint, dead-code analysis, build, and
  pure unit tests including the framer property tests.

## The evidence

This is not a preference. The identical smoke test — session establishment, half-close,
multi-frame response, datagram round trip — was run on both runtimes on the same machine:

| runtime | functional checks | outcome |
|---|---|---|
| Bun 1.3.11 | all passed | **segfault on exit, 3 of 3 runs** |
| Node 20.20.2 | all passed | clean exit, 0 of 3 crashed |

The crash is in native-addon teardown. Every functional assertion passed first, which is
what makes it dangerous: the failure looks like flaky CI rather than an incompatibility.

## Alternative rejected

One runtime for everything. Bun alone crashes. Node alone gives up Bun's speed on the
large majority of tasks that never touch the transport.

## Enforcement

A naming convention is a convention. This is enforced two ways so it is mechanical:

1. **Filename split.** `*.node.test.ts` for anything that loads the transport, with
   separate scripts, and CI runs both tasks. A test importing the transport must never be
   reachable from the Bun task.
2. **An import-boundary lint rule** forbidding imports of the transport package from any
   file not matching `*.node.*`.

The lint rule is the load-bearing half. A misnamed file still passes the glob; it does not
pass the lint. The failure surfaces at typecheck rather than as a segfault.

## Revisit when

Bun fixes native-addon teardown and the smoke test exits cleanly 20 times in a row, or the
transport gains a pure-JS implementation that loads no addon.
