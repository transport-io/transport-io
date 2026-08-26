/**
 * The emit lane's bound, asserted through a Session.
 *
 * This is the second time D15 has been dead code, and the two deaths are worth keeping
 * side by side because the second one was *caused* by the first fix.
 *
 * Death 1. `emit` drained the queue synchronously on every push, so a burst never queued
 * and neither the datagram ring nor its TTL ever applied.
 *
 * Death 2. The fix made the *datagram* flush coalesced — `#flushDatagrams` defers through
 * an injectable scheduler, which is why the ring and TTL are now genuinely exercised. The
 * emit flush was left synchronous and unconditional: push, then drain the whole queue on
 * the same turn into `#write`, which only appended to an unbounded promise chain and
 * returned. Depth therefore returned to 0 after every push, `length >= max` could never be
 * true from a Session, and `CloseCode.WT_PEER_TOO_SLOW` was unreachable. The backlog had
 * not gone anywhere — it moved from a bounded queue that disconnects into an unbounded
 * chain that does not, and whose `.catch(() => undefined)` also discarded every write
 * failure on the lane that advertises reliable ordered delivery.
 *
 * The lesson is that a bound is only a bound if something *stays* in the bounded thing.
 * The test that existed constructed `new EmitQueue(3)` and pushed four items — it asserted
 * the queue, which was never wrong, and never went through a Session, which was.
 */
import { describe, expect, test } from 'bun:test'
import { buildEventTable, defineContract, type MapOf, type$ } from './contract.ts'
import { CloseCode, EMIT_QUEUE_MAX } from './protocol.ts'
import { Session } from './session.ts'
import type { BidiStream, CloseInfo, Connection } from './transport/types.ts'

const contract = defineContract({
  chat: { lane: 'stream', payload: type$<{ body: string }>() },
})
interface AppMap extends MapOf<typeof contract> {}
void (0 as unknown as AppMap)

interface Stalling {
  readonly conn: Connection
  readonly closed: Promise<CloseInfo>
  /** Frames the transport actually accepted. */
  accepted: number
}

/**
 * A peer that accepts the handshake and then never takes another byte — the real shape of
 * "too slow", and the one a `TransformStream` pair cannot produce, because loopback drains
 * as fast as we write.
 */
function stallingPeer(opts: { failWrite?: boolean } = {}): Stalling {
  let resolveClosed!: (i: CloseInfo) => void
  const closed = new Promise<CloseInfo>((r) => {
    resolveClosed = r
  })
  const state: Stalling = { conn: undefined as unknown as Connection, closed, accepted: 0 }

  const writable = new WritableStream<Uint8Array>({
    write() {
      state.accepted++
      if (state.accepted === 1) return Promise.resolve() // frame 0: the handshake
      if (opts.failWrite === true) return Promise.reject(new Error('transport write failed'))
      return new Promise<void>(() => {}) // never settles: the peer has stopped reading
    },
  })

  const conn: Connection = {
    closed,
    openEmitStream: async () => writable,
    onEmitStream: () => {},
    openBidi: async () => ({}) as BidiStream,
    onBidi: () => {},
    sendDatagram: () => {},
    onDatagram: () => {},
    maxDatagramSize: () => 1024,
    reliability: () => 'supports-unreliable',
    close: (code, reason) => resolveClosed({ code, reason }),
  }
  return Object.assign(state, { conn })
}

async function sessionOn(s: Stalling): Promise<Session> {
  const session = new Session(s.conn, { table: await buildEventTable(contract), origin: 1 })
  void session.start().catch(() => undefined) // never completes: no peer handshake arrives
  await new Promise((r) => setTimeout(r, 5))
  return session
}

describe('the emit bound is reachable, and reaching it disconnects the peer', () => {
  test('a peer that stops reading is closed with WT_PEER_TOO_SLOW', async () => {
    const peer = stallingPeer()
    const session = await sessionOn(peer)

    const frame = new Uint8Array(64)
    // Comfortably past the bound. Before the fix this ran to completion with the queue at
    // depth 0 throughout, the frames piling up inside an unbounded promise chain.
    for (let i = 0; i < EMIT_QUEUE_MAX * 2; i++) session.sendEncodedFrame(frame)

    const info = await Promise.race([
      peer.closed,
      new Promise<CloseInfo>((r) =>
        setTimeout(() => r({ code: -1, reason: 'never closed' }), 500),
      ),
    ])
    expect(info.code).toBe(CloseCode.WT_PEER_TOO_SLOW)
  })

  test('the queue actually holds the backlog, so the depth means something', async () => {
    const peer = stallingPeer()
    const session = await sessionOn(peer)

    const frame = new Uint8Array(64)
    for (let i = 0; i < 100; i++) session.sendEncodedFrame(frame)
    await new Promise((r) => setTimeout(r, 20))

    // The transport took the handshake and one emit; the other 99 are still queued, which
    // is the whole point. Before the fix depth was 0 here and `accepted` was 2 — every
    // other frame was parked in `#writeChain`, invisible and unbounded.
    expect(peer.accepted).toBeLessThanOrEqual(2)
    expect(session.emitQueueDepth).toBeGreaterThan(90)
  })

  test('the session survives up to the bound and is not closed early', async () => {
    const peer = stallingPeer()
    const session = await sessionOn(peer)

    const frame = new Uint8Array(64)
    for (let i = 0; i < EMIT_QUEUE_MAX - 8; i++) session.sendEncodedFrame(frame)
    const info = await Promise.race([
      peer.closed,
      new Promise<CloseInfo>((r) => setTimeout(() => r({ code: -1, reason: 'still up' }), 120)),
    ])
    expect(info.reason).toBe('still up')
  })
})

describe('a write failure on the emit lane is not swallowed', () => {
  test('a rejected write closes the session instead of vanishing', async () => {
    const peer = stallingPeer({ failWrite: true })
    const session = await sessionOn(peer)

    session.sendEncodedFrame(new Uint8Array(64))

    // §5.5: there is one emit stream per direction and no way to reopen it, so a fault on
    // it escalates to the session. `.catch(() => undefined)` made it escalate to nothing —
    // on the lane that advertises reliable ordered delivery.
    const info = await Promise.race([
      peer.closed,
      new Promise<CloseInfo>((r) =>
        setTimeout(() => r({ code: -1, reason: 'never closed' }), 500),
      ),
    ])
    expect(info.code).not.toBe(-1)
  })
})
