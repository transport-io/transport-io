/**
 * Teardown as a property, rather than as a list.
 *
 * `dispose()` released the things somebody remembered to add to it, and the test guarding it
 * was itself written as a list, with the same weakness: two timers were added to `Session`
 * over its life and neither reached either list. D117 is the incident. A list nobody consults
 * while adding a timer three hundred lines away is not a mechanism, it is a hope, and it is
 * the same shape as the allowlists this repository has already replaced with property checks.
 *
 * So this names no timer and no promise. After a session is disposed, whatever lifecycle it
 * was in when disposal arrived:
 *
 *   1. no timer it created is still live, and
 *   2. `start()` has settled.
 *
 * The second is the half a timer registry cannot give. `start()` parks on the emit stream,
 * then on the handshake write, then on `ready`, and only a timer or a peer can ever answer
 * any of them. Releasing the timer without answering the await it was parked on trades a leak
 * for a hang, which is what the first attempt at D117's fix did. When a fourth await is added,
 * nobody has to know it exists: disposing a session parked on it fails here on the budget.
 */
import { describe, expect, test } from 'bun:test'
import { buildEventTable, defineContract, reliable } from './contract.ts'
import { Session } from './session.ts'
import { loopbackPair } from './transport/loopback.ts'
import type { BidiStream, CloseInfo, Connection } from './transport/types.ts'

const contract = defineContract({ chat: reliable<{ body: string }>() })

/**
 * Captured before anything is patched, so the harness's own waits are never counted as
 * timers under test and never stop working when the globals are swapped.
 */
const realSetTimeout = globalThis.setTimeout
const wait = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    realSetTimeout(resolve, ms)
  })

/** Settled either way, and observed at once, so a rejection is never left unhandled. */
const observe = (p: Promise<unknown>): Promise<void> =>
  p.then(
    () => undefined,
    () => undefined,
  )

interface Tracked {
  /** Timers created since tracking began and neither fired nor cleared. */
  live(): number
  restore(): void
}

/**
 * Counts every timer the code under test creates. A one-shot that has fired is not live, so
 * it is dropped when it runs; an interval is live until it is cleared.
 */
function trackTimers(): Tracked {
  const realSet = globalThis.setTimeout
  const realClear = globalThis.clearTimeout
  const realSetInterval = globalThis.setInterval
  const realClearInterval = globalThis.clearInterval
  const live = new Set<unknown>()

  globalThis.setTimeout = ((fn: () => void, ms?: number) => {
    let handle: unknown
    handle = realSet(() => {
      live.delete(handle)
      fn()
    }, ms)
    live.add(handle)
    return handle
  }) as typeof globalThis.setTimeout

  globalThis.clearTimeout = ((handle: never) => {
    live.delete(handle)
    realClear(handle)
  }) as typeof globalThis.clearTimeout

  globalThis.setInterval = ((fn: () => void, ms?: number) => {
    const handle = realSetInterval(fn, ms)
    live.add(handle)
    return handle
  }) as typeof globalThis.setInterval

  globalThis.clearInterval = ((handle: never) => {
    live.delete(handle)
    realClearInterval(handle)
  }) as typeof globalThis.clearInterval

  return {
    live: () => live.size,
    restore: () => {
      globalThis.setTimeout = realSet
      globalThis.clearTimeout = realClear
      globalThis.setInterval = realSetInterval
      globalThis.clearInterval = realClearInterval
    },
  }
}

/**
 * Long enough that a real settle is never mistaken for a hang, short enough that a hang is
 * reported as a failure rather than as a suite that stopped. Absolute, not a proportion of
 * anything measured here.
 */
const SETTLE_BUDGET_MS = 250

/** The invariant. Nothing below states which timer or which promise it is waiting on. */
async function disposeAndAssertReleased(
  t: Tracked,
  sessions: readonly Session[],
  started: readonly Promise<void>[],
): Promise<void> {
  for (const s of sessions) s.dispose()

  const outcome = await Promise.race([
    Promise.all(started).then(() => 'settled'),
    wait(SETTLE_BUDGET_MS).then(() => 'still parked after disposal'),
  ])
  expect(outcome).toBe('settled')
  expect(t.live()).toBe(0)
}

/** A transport that accepts a session and then answers nothing, ever. */
function stalledConnection(): Connection {
  return {
    closed: new Promise<CloseInfo>(() => {}),
    openEmitStream: () => new Promise<WritableStream<Uint8Array>>(() => {}),
    onEmitStream: () => {},
    openBidi: async () => ({}) as BidiStream,
    onBidi: () => {},
    sendDatagram: () => {},
    onDatagram: () => {},
    maxDatagramSize: () => 1024,
    reliability: () => 'supports-unreliable',
    close: () => {},
  }
}

describe('disposal releases every timer and settles start(), in every lifecycle', () => {
  test('after a completed handshake', async () => {
    const t = trackTimers()
    try {
      const table = await buildEventTable(contract)
      const [serverSide, clientSide] = loopbackPair()
      const a = new Session(serverSide, { table, origin: 0x1000_0001 })
      const b = new Session(clientSide, { table, origin: 0x1000_0002 })
      const started = [observe(a.start()), observe(b.start())]
      await Promise.all(started)

      // The sweep interval is armed only on the success path, so this is the case where
      // disposal has something to release that the failure paths never create.
      expect(t.live()).toBeGreaterThan(0)
      await disposeAndAssertReleased(t, [a, b], started)
    } finally {
      t.restore()
    }
  })

  test('parked on the peer handshake, from a peer that never answers', async () => {
    const t = trackTimers()
    try {
      const table = await buildEventTable(contract)
      // Only our half is started, so our handshake is written and nothing answers it.
      const [, clientSide] = loopbackPair()
      const s = new Session(clientSide, { table, origin: 1, handshakeDeadlineMs: 60_000 })
      const started = [observe(s.start())]
      await wait(20)

      expect(t.live()).toBe(1)
      await disposeAndAssertReleased(t, [s], started)
    } finally {
      t.restore()
    }
  })

  test('parked on the emit stream, which the transport never opens', async () => {
    const t = trackTimers()
    try {
      const table = await buildEventTable(contract)
      // The deadline is set far out on purpose: nothing but disposal can release this one,
      // so a `dispose()` that only clears the timer leaves `start()` parked for ever.
      const s = new Session(stalledConnection(), {
        table,
        origin: 1,
        handshakeDeadlineMs: 60_000,
      })
      const started = [observe(s.start())]
      await wait(20)

      expect(t.live()).toBe(1)
      await disposeAndAssertReleased(t, [s], started)
    } finally {
      t.restore()
    }
  })

  test('the deadline left to fire on its own, with no disposal at all', async () => {
    const t = trackTimers()
    try {
      const table = await buildEventTable(contract)
      const s = new Session(stalledConnection(), {
        table,
        origin: 1,
        handshakeDeadlineMs: 40,
      })
      const started = [observe(s.start())]

      // Nobody disposes. The deadline is the whole teardown, and it has to leave the same
      // state behind: nothing live, and `start()` answered.
      const outcome = await Promise.race([
        Promise.all(started).then(() => 'settled'),
        wait(SETTLE_BUDGET_MS).then(() => 'still parked after the deadline'),
      ])
      expect(outcome).toBe('settled')
      expect(t.live()).toBe(0)
    } finally {
      t.restore()
    }
  })

  test('disposed before start() was ever called, and disposed twice', async () => {
    const t = trackTimers()
    try {
      const table = await buildEventTable(contract)
      const s = new Session(stalledConnection(), { table, origin: 1 })
      s.dispose()
      s.dispose()
      expect(t.live()).toBe(0)

      // And a session disposed while parked, twice, is still released exactly once.
      const two = new Session(stalledConnection(), {
        table,
        origin: 2,
        handshakeDeadlineMs: 60_000,
      })
      const started = [observe(two.start())]
      await wait(20)
      two.dispose()
      await disposeAndAssertReleased(t, [two], started)
    } finally {
      t.restore()
    }
  })
})
