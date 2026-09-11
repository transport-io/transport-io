/**
 * The WebSocket mapping (PROTOCOL.md §3.3), against a socket the test owns and then against
 * two of them wired together under a real Session pair.
 *
 * Every claim the mapping makes has a case here that fails without it: the close-code
 * offset, the reason cap, binary only, the write that parks on `bufferedAmount`, the emit
 * queue's bound being reachable at all, the DATAGRAM frame that carries a declared
 * unreliable event, the low-water rule that keeps those frames out of a backed-up lane, the
 * refusal of a DATAGRAM frame on a session that has real datagrams, the keepalive a silent
 * sender emits and a busy one does not, and the deadline that closes a silent peer. The real
 * socket, and the paused peer that fills a real kernel buffer, are in `websocket.node.test.ts`.
 */
import { describe, expect, test } from 'bun:test'
import { buildEventTable, defineContract, reliable, unreliable } from '../contract.ts'
import type { TransportError } from '../errors.ts'
import { encodeFrame, FrameDecoder } from '../framer.ts'
import {
  CloseCode,
  Codec,
  EMIT_QUEUE_MAX,
  EVENT_ID_NOT_APPLICABLE,
  FALLBACK_UNRELIABLE_LOW_WATER,
  FrameType,
  WS_CLOSE_REASON_MAX_BYTES,
} from '../protocol.ts'
import { Session } from '../session.ts'
import { loopbackPair } from './loopback.ts'
import {
  fromWebSocketCloseCode,
  type SocketLike,
  toWebSocketCloseCode,
  truncateCloseReason,
  WebSocketConnection,
} from './websocket-connection.ts'

type Listener = (ev: never) => void
type Event = { data?: unknown; code?: number; reason?: string }
const fire = (l: Listener, ev: Event): void => (l as (ev: Event) => void)(ev)

/**
 * A socket the test owns. What it sends is visible, `bufferedAmount` is whatever the test
 * says it is, and a peer, when wired, receives a copy of every send on the next microtask.
 */
class FakeSocket implements SocketLike {
  binaryType = 'blob'
  bufferedAmount = 0
  readyState = 1
  readonly sent: Uint8Array[] = []
  peer: FakeSocket | undefined
  readonly #listeners = new Map<string, Listener[]>()

  send(data: Uint8Array): void {
    if (this.readyState !== 1) throw new Error('not open')
    this.sent.push(data.slice())
    const peer = this.peer
    if (peer === undefined) return
    const copy = data.slice()
    queueMicrotask(() => peer.receive(copy.buffer))
  }

  receive(data: unknown): void {
    for (const l of this.#listeners.get('message') ?? []) fire(l, { data })
  }

  close(code = 1000, reason = ''): void {
    if (this.readyState === 3) return
    this.readyState = 3
    queueMicrotask(() => {
      for (const l of this.#listeners.get('close') ?? []) fire(l, { code, reason })
      this.peer?.close(code, reason)
    })
  }

  addEventListener(type: string, listener: Listener): void {
    const list = this.#listeners.get(type) ?? []
    list.push(listener)
    this.#listeners.set(type, list)
  }
}

function pair(): [FakeSocket, FakeSocket] {
  const a = new FakeSocket()
  const b = new FakeSocket()
  a.peer = b
  b.peer = a
  return [a, b]
}

const wait = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms)
  })

const contract = defineContract({
  chat: reliable<{ body: string }>(),
  cursor: unreliable<{ n: number }>({ fallback: 'newest' }),
})

/** Every frame a socket has sent so far, decoded, so the wire can be asserted on. */
function framesSentBy(socket: FakeSocket) {
  const decoder = new FrameDecoder()
  return socket.sent.flatMap((bytes) => decoder.push(bytes))
}

// norm: websocket-close-code-offset
describe('the close-code mapping', () => {
  test('WT_NO_ERROR is a normal closure and every other code rides in the private range', () => {
    expect(toWebSocketCloseCode(CloseCode.WT_NO_ERROR)).toBe(1000)
    expect(toWebSocketCloseCode(CloseCode.WT_PEER_TOO_SLOW)).toBe(4003)
    expect(toWebSocketCloseCode(CloseCode.WT_RELIABILITY_REFUSED)).toBe(4006)
    expect(fromWebSocketCloseCode(1000)).toBe(CloseCode.WT_NO_ERROR)
    expect(fromWebSocketCloseCode(4003)).toBe(CloseCode.WT_PEER_TOO_SLOW)
  })

  test("the socket's own codes pass through, since a lost connection is not one of ours", () => {
    expect(fromWebSocketCloseCode(1006)).toBe(1006)
    expect(fromWebSocketCloseCode(1001)).toBe(1001)
  })

  test('a reason is cut to the cap on a character boundary, never inside one', () => {
    const encoder = new TextEncoder()
    expect(truncateCloseReason('short')).toBe('short')
    const ascii = truncateCloseReason('a'.repeat(300))
    expect(encoder.encode(ascii).byteLength).toBe(WS_CLOSE_REASON_MAX_BYTES)
    const twoByte = truncateCloseReason('é'.repeat(300))
    expect(encoder.encode(twoByte).byteLength).toBeLessThanOrEqual(WS_CLOSE_REASON_MAX_BYTES)
    expect(twoByte).toBe('é'.repeat(Math.floor(WS_CLOSE_REASON_MAX_BYTES / 2)))
  })
})

describe('the seam over one socket', () => {
  test('reports what it is, and the same datagram ceiling as the native transport', () => {
    const conn = new WebSocketConnection(new FakeSocket())
    expect(conn.kind()).toBe('websocket')
    expect(conn.reliability()).toBe('reliable-only')
    expect(conn.maxDatagramSize()).toBe(1024)
  })

  test('sets binary delivery, and hands both binary shapes to the emit stream as bytes', async () => {
    const socket = new FakeSocket()
    const conn = new WebSocketConnection(socket)
    expect(socket.binaryType).toBe('arraybuffer')
    let readable: ReadableStream<Uint8Array> | undefined
    conn.onEmitStream((r) => {
      readable = r
    })
    const reader = (readable as ReadableStream<Uint8Array>).getReader()
    socket.receive(Uint8Array.of(1, 2, 3).buffer)
    socket.receive(Uint8Array.of(4, 5))
    expect(Array.from((await reader.read()).value ?? [])).toEqual([1, 2, 3])
    expect(Array.from((await reader.read()).value ?? [])).toEqual([4, 5])
  })

  // norm: websocket-binary-only
  test('a text message is a protocol error that closes the lane', async () => {
    const socket = new FakeSocket()
    const conn = new WebSocketConnection(socket)
    socket.receive('not bytes')
    expect(socket.readyState).toBe(3)
    expect((await conn.closed).code).toBe(CloseCode.WT_PROTOCOL_ERROR)
  })

  test('there are no bidirectional streams, and the refusal says where call() went', async () => {
    const conn = new WebSocketConnection(new FakeSocket())
    const err = (await conn.openBidi().catch((e: unknown) => e)) as TransportError
    expect(err.code).toBe('WT_LANE_UNAVAILABLE')
    expect(err.remedy).toContain('client.native')
  })

  test('a datagram reaching the socket is a bug, not something to drop quietly', () => {
    const conn = new WebSocketConnection(new FakeSocket())
    expect(() => conn.sendDatagram()).toThrow(/DATAGRAM frames/)
  })

  test('close maps the code and caps the reason, and closed reports the mapped code back', async () => {
    const socket = new FakeSocket()
    const conn = new WebSocketConnection(socket)
    let seen: { code?: number; reason?: string } = {}
    socket.addEventListener('close', (ev: { code: number; reason: string }) => {
      seen = ev
    })
    conn.close(CloseCode.WT_PEER_TOO_SLOW, 'x'.repeat(500))
    expect((await conn.closed).code).toBe(CloseCode.WT_PEER_TOO_SLOW)
    expect(seen.code).toBe(4003)
    expect(seen.reason?.length).toBe(WS_CLOSE_REASON_MAX_BYTES)
  })

  test('a write parks while bufferedAmount is above the low-water mark, and resolves when it drains', async () => {
    const socket = new FakeSocket()
    const conn = new WebSocketConnection(socket, { lowWaterBytes: 100 })
    const writer = (await conn.openEmitStream()).getWriter()
    socket.bufferedAmount = 1_000
    let settled = false
    const pending = writer.write(Uint8Array.of(1)).then(() => {
      settled = true
    })
    await wait(30)
    expect(socket.sent).toHaveLength(1)
    expect(settled).toBe(false)
    socket.bufferedAmount = 0
    await pending
    expect(settled).toBe(true)
  })

  test('with no low-water mark every write resolves at once, which is the defect the mark exists for', async () => {
    const socket = new FakeSocket()
    const conn = new WebSocketConnection(socket, { lowWaterBytes: Number.POSITIVE_INFINITY })
    const writer = (await conn.openEmitStream()).getWriter()
    socket.bufferedAmount = 1_000_000
    await writer.write(Uint8Array.of(1))
    expect(socket.sent).toHaveLength(1)
  })

  test('a write after the socket closed rejects, and a parked write is released by the close', async () => {
    const socket = new FakeSocket()
    const conn = new WebSocketConnection(socket, { lowWaterBytes: 100 })
    const writer = (await conn.openEmitStream()).getWriter()
    socket.bufferedAmount = 1_000
    const parked = writer.write(Uint8Array.of(1)).catch((e: unknown) => e)
    await wait(10)
    socket.close(1000, '')
    await conn.closed
    expect(((await parked) as TransportError).code).toBe('WT_SESSION_CLOSED')
  })
})

describe('a session pair over two sockets', () => {
  async function connected(
    clock = () => 1_000,
    lowWaterBytes?: number,
  ): Promise<{
    a: Session
    b: Session
    sa: FakeSocket
    sb: FakeSocket
    ca: WebSocketConnection
  }> {
    const table = await buildEventTable(contract)
    const [sa, sb] = pair()
    const ca = new WebSocketConnection(sa, lowWaterBytes === undefined ? {} : { lowWaterBytes })
    const a = new Session(ca, { table, origin: 1, now: clock })
    const b = new Session(new WebSocketConnection(sb), { table, origin: 2, now: clock })
    await Promise.all([a.start(), b.start()])
    return { a, b, sa, sb, ca }
  }

  /**
   * One frame per task, so writes get every chance to complete between emits. A synchronous
   * burst of 257 would trip the bound on any transport and prove nothing about the sink.
   */
  async function paced(session: Session, frames: number): Promise<void> {
    for (let i = 0; i < frames; i++) {
      try {
        session.emit('chat', { body: `${i}` })
      } catch {
        return
      }
      await wait(0)
    }
  }

  test('the handshake is frame 0 of the first message, and the reliable lane crosses', async () => {
    const { a, b, sa } = await connected()
    const first = framesSentBy(sa)[0]
    expect(first?.type).toBe(FrameType.HANDSHAKE)

    const got: string[] = []
    b.on('chat', (p) => got.push((p as { body: string }).body))
    a.emit('chat', { body: 'over a socket' })
    await wait(20)
    expect(got).toEqual(['over a socket'])
    a.dispose()
    b.dispose()
  })

  test('a declared unreliable event travels as a DATAGRAM frame on the emit lane, and arrives', async () => {
    const { a, b, sa } = await connected()
    const got: number[] = []
    b.on('cursor', (p) => got.push((p as { n: number }).n))
    a.emit('cursor', { n: 7 })
    await wait(20)
    expect(got).toEqual([7])
    const wrapped = framesSentBy(sa).filter((f) => f.type === FrameType.DATAGRAM)
    expect(wrapped).toHaveLength(1)
    expect(wrapped[0]?.eventId).toBe(EVENT_ID_NOT_APPLICABLE)
    // Never a datagram on the socket itself: the connection would have thrown.
    a.dispose()
    b.dispose()
  })

  // norm: websocket-unreliable-low-water
  test('unreliable frames stay in the ring while the emit lane is backed up, and leave when it drains', async () => {
    const { a, b, sa } = await connected()
    const got: number[] = []
    b.on('cursor', (p) => got.push((p as { n: number }).n))

    // Nothing completes: every write parks, and the reliable frames pile up past the mark.
    sa.bufferedAmount = 1_000_000
    for (let i = 0; i < FALLBACK_UNRELIABLE_LOW_WATER + 8; i++) a.emit('chat', { body: `${i}` })
    await wait(10)
    expect(a.emitQueueDepth).toBeGreaterThanOrEqual(FALLBACK_UNRELIABLE_LOW_WATER)

    for (let n = 0; n < 10; n++) a.emit('cursor', { n })
    await wait(10)
    expect(a.stats().queueDepth).toBe(10)
    expect(framesSentBy(sa).filter((f) => f.type === FrameType.DATAGRAM)).toHaveLength(0)

    sa.bufferedAmount = 0
    await wait(400)
    expect(got).toHaveLength(10)
    expect(a.stats().queueDepth).toBe(0)
    a.dispose()
    b.dispose()
  })

  test('the emit queue bound is reachable: a peer that never drains is disconnected as too slow', async () => {
    const { b, sa, ca, a } = await connected()
    sa.bufferedAmount = 1_000_000
    await paced(a, EMIT_QUEUE_MAX + 2)
    expect((await ca.closed).code).toBe(CloseCode.WT_PEER_TOO_SLOW)
    b.dispose()
  })

  test('with the polling off the same peer is never disconnected, which is writer.ready in a new costume', async () => {
    const { a, b, sa, ca } = await connected(undefined, Number.POSITIVE_INFINITY)
    sa.bufferedAmount = 1_000_000
    await paced(a, EMIT_QUEUE_MAX + 2)
    const outcome = await Promise.race([
      ca.closed.then(() => 'closed'),
      wait(50).then(() => 'still open'),
    ])
    expect(outcome).toBe('still open')
    expect(a.emitQueueDepth).toBeLessThanOrEqual(1)
    a.dispose()
    b.dispose()
  })

  test('a burst on the unreliable lane alone can never disconnect the peer', async () => {
    const { a, b, sa } = await connected()
    sa.bufferedAmount = 1_000_000
    for (let i = 0; i < EMIT_QUEUE_MAX * 2; i++) a.emit('cursor', { n: i })
    await wait(30)
    expect(a.emitQueueDepth).toBeLessThanOrEqual(FALLBACK_UNRELIABLE_LOW_WATER)
    expect(a.stats().overflowDropped).toBeGreaterThan(0)
    a.dispose()
    b.dispose()
  })
})

// norm: datagram-frame-websocket-only
// norm: websocket-keepalive
// norm: websocket-idle-timeout
describe('liveness on the mapping', () => {
  const quick = { keepaliveIntervalMs: 20, idleTimeoutMs: 90 }

  test('a peer that has sent nothing for the interval sends an empty message, and one that keeps sending does not', async () => {
    const [sa, sb] = pair()
    const conn = new WebSocketConnection(sa, quick)
    new WebSocketConnection(sb, quick)
    await wait(70)
    expect(sa.sent.filter((m) => m.byteLength === 0).length).toBeGreaterThanOrEqual(1)

    const writer = (await conn.openEmitStream()).getWriter()
    const before = sa.sent.length
    for (let i = 0; i < 12; i++) {
      await writer.write(new Uint8Array([1]))
      await wait(5)
    }
    expect(sa.sent.slice(before).filter((m) => m.byteLength === 0)).toHaveLength(0)
    conn.close(CloseCode.WT_NO_ERROR, '')
  })

  test('an empty message is proof of life and never reaches the emit stream', async () => {
    const [sa, sb] = pair()
    // `sa` sends keepalives and nothing else; `sb` would close after 90 ms of silence.
    new WebSocketConnection(sa, { keepaliveIntervalMs: 20, idleTimeoutMs: 10_000 })
    const conn = new WebSocketConnection(sb, quick)
    const chunks: Uint8Array[] = []
    conn.onEmitStream((readable) => {
      void (async () => {
        for await (const chunk of readable) chunks.push(chunk)
      })()
    })
    let settled = false
    void conn.closed.then(() => {
      settled = true
    })
    await wait(300)
    expect(settled).toBe(false)
    expect(sb.sent.filter((m) => m.byteLength === 0).length).toBeGreaterThanOrEqual(1)
    expect(chunks).toHaveLength(0)
    conn.close(CloseCode.WT_NO_ERROR, '')
  })

  test('a peer silent for the deadline is closed as WT_IDLE_TIMEOUT, and told so on the socket', async () => {
    const [sa, sb] = pair()
    const conn = new WebSocketConnection(sa, { keepaliveIntervalMs: 10_000, idleTimeoutMs: 60 })
    // `sb` is a bare socket that never sends.
    let told: { code: number; reason: string } | undefined
    sb.addEventListener('close', (ev) => {
      told = ev
    })
    const info = await Promise.race([conn.closed, wait(1_000).then(() => 'never closed')])
    expect(info).toMatchObject({ code: CloseCode.WT_IDLE_TIMEOUT })
    expect((info as { reason: string }).reason).toContain('60 ms')
    await wait(0)
    expect(told?.code).toBe(toWebSocketCloseCode(CloseCode.WT_IDLE_TIMEOUT))
  })

  test('the deadline is re-armed by every message, so a peer that keeps sending is never closed', async () => {
    const [sa, sb] = pair()
    const conn = new WebSocketConnection(sa, { keepaliveIntervalMs: 10_000, idleTimeoutMs: 60 })
    const ticker = setInterval(() => sb.send(new Uint8Array([1])), 15)
    let settled = false
    void conn.closed.then(() => {
      settled = true
    })
    await wait(250)
    clearInterval(ticker)
    expect(settled).toBe(false)
    conn.close(CloseCode.WT_NO_ERROR, '')
  })
})

describe('a DATAGRAM frame on a session with real datagrams', () => {
  test('is a protocol error, because it would route around the lane', async () => {
    const table = await buildEventTable(contract)
    const [x, y] = loopbackPair()
    const a = new Session(x, { table, origin: 1 })
    const b = new Session(y, { table, origin: 2 })
    await Promise.all([a.start(), b.start()])

    // A second emit stream from x reaches b's read loop once the handshake is negotiated.
    const writer = (await x.openEmitStream()).getWriter()
    await writer.write(
      encodeFrame({
        type: FrameType.DATAGRAM,
        codec: Codec.JSON,
        eventId: EVENT_ID_NOT_APPLICABLE,
        payload: Uint8Array.of(1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14),
      }),
    )
    expect((await y.closed).code).toBe(CloseCode.WT_PROTOCOL_ERROR)
    a.dispose()
    b.dispose()
  })
})
