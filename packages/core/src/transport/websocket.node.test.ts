/**
 * The WebSocket mapping on a real socket.
 *
 * The listener is `ws` over `node:http`, the client is Node's own WebSocket, and nothing in
 * between is a double. The last two tests are the ones the sink exists for: a peer that
 * stopped reading fills a real kernel buffer, the client's `bufferedAmount` climbs, writes
 * park, the emit queue reaches its bound and the session closes as `WT_PEER_TOO_SLOW`. With
 * the polling off the same peer is never noticed, which is the defect D93 measured on the
 * reference binding, reproduced on purpose so nobody removes the poll as a simplification.
 */
import assert from 'node:assert/strict'
import { once } from 'node:events'
import type { AddressInfo } from 'node:net'
import { test } from 'node:test'
import { WebSocket, WebSocketServer } from 'ws'
import { Client } from '../client.ts'
import {
  buildEventTable,
  defineContract,
  type MapOf,
  reliable,
  rpc,
  unreliable,
} from '../contract.ts'
import type { TransportError } from '../errors.ts'
import { CloseCode } from '../protocol.ts'
import { createServer } from '../server.ts'
import { Session } from '../session.ts'
import { PROBE_PATH } from './probe.ts'
import { listenWebSocket } from './websocket.node.ts'
import { connectWebSocket, type SocketLike, WebSocketConnection } from './websocket.ts'

const contract = defineContract({
  chat: reliable<{ body: string }>(),
  cursor: unreliable<{ n: number }>({ fallback: 'newest' }),
  save: rpc<{ text: string }, { n: number }>(),
})
interface AppMap extends MapOf<typeof contract> {}

const settle = (ms = 200): Promise<void> =>
  new Promise((resolve) => {
    // Unreferenced, so a race this loses does not hold the process open for its whole span.
    setTimeout(resolve, ms).unref()
  })

test('a session over a real socket: handshake, both directions, a declared unreliable event, a refused call', async () => {
  const listener = await listenWebSocket({ port: 0 })
  const server = createServer<AppMap>({ contract })
  await server.listen()
  server.withFallback(listener)
  server.onSession((peer) => {
    void peer.join('lobby')
    peer.on('chat', (p) => void server.to('lobby').emit('chat', p))
    peer.on('cursor', (p) => void server.to('lobby').emit('cursor', p))
  })

  const client = new Client<AppMap>({
    contract,
    connect: () => connectWebSocket({ url: `ws://127.0.0.1:${listener.port}/` }),
  })
  await client.connect()
  assert.equal(client.getSnapshot().transport, 'websocket')

  const chat: string[] = []
  const cursor: number[] = []
  client.on('chat', (p) => chat.push(p.body))
  client.on('cursor', (p) => cursor.push(p.n))
  await settle()

  client.emit('chat', { body: 'over tcp' })
  client.emit('cursor', { n: 7 })
  await settle()
  assert.deepEqual(chat, ['over tcp'])
  assert.deepEqual(cursor, [7])

  await assert.rejects(
    client.call('save', { text: 'x' }),
    (e: unknown) => (e as TransportError).code === 'WT_LANE_UNAVAILABLE',
  )
  assert.equal(client.getSnapshot().status, 'connected')

  client.disconnect()
  listener.stop()
})

test('the listener answers the probe over TCP, so a blocked QUIC path can be told from a dead server', async () => {
  const listener = await listenWebSocket({ port: 0 })
  const probe = await fetch(`http://127.0.0.1:${listener.port}${PROBE_PATH}`, {
    method: 'HEAD',
  })
  assert.equal(probe.status, 204)
  const other = await fetch(`http://127.0.0.1:${listener.port}/anything`)
  assert.equal(other.status, 404)
  listener.stop()
})

/**
 * Two sessions over one raw `ws` server, so the test can hold the server's socket and pause
 * it. `pause()` stops the read side; the kernel buffers on both ends then fill, and only
 * after that does the client's `bufferedAmount` start to climb.
 */
async function pausedPeer(lowWaterBytes?: number): Promise<{
  session: Session
  conn: WebSocketConnection
  stop: () => void
}> {
  const wss = new WebSocketServer({ port: 0, host: '127.0.0.1' })
  await once(wss, 'listening')
  const port = (wss.address() as AddressInfo).port
  const serverSide = new Promise<WebSocket>((resolve) => wss.once('connection', resolve))
  const clientSocket = new WebSocket(`ws://127.0.0.1:${port}/`)
  await once(clientSocket, 'open')
  const serverSocket = await serverSide

  const table = await buildEventTable(contract)
  const conn = new WebSocketConnection(
    clientSocket as unknown as SocketLike,
    lowWaterBytes === undefined ? {} : { lowWaterBytes },
  )
  const session = new Session(conn, { table, origin: 1 })
  const peer = new Session(new WebSocketConnection(serverSocket as unknown as SocketLike), {
    table,
    origin: 2,
  })
  await Promise.all([session.start(), peer.start()])
  serverSocket.pause()

  return {
    session,
    conn,
    stop: () => {
      peer.dispose()
      serverSocket.terminate()
      clientSocket.terminate()
      wss.close()
    },
  }
}

/** One frame per task against the paused peer, until the session refuses the next one. */
async function produce(session: Session, frames: number): Promise<void> {
  const body = 'x'.repeat(32 * 1024)
  for (let i = 0; i < frames; i++) {
    try {
      session.emit('chat', { body })
    } catch {
      return
    }
    await new Promise((resolve) => setImmediate(resolve))
  }
}

test('the emit queue bound is reachable on a real socket whose peer stopped reading', {
  timeout: 30_000,
}, async () => {
  const { session, conn, stop } = await pausedPeer()
  try {
    const producing = produce(session, 4000)
    const outcome = await Promise.race([
      conn.closed.then((info) => info.code),
      settle(20_000).then(() => 'never closed'),
    ])
    assert.equal(outcome, CloseCode.WT_PEER_TOO_SLOW)
    await producing
  } finally {
    stop()
  }
})

test('with the polling off the same peer is never noticed, and the queue measures nothing', {
  timeout: 30_000,
}, async () => {
  const { session, conn, stop } = await pausedPeer(Number.POSITIVE_INFINITY)
  try {
    const producing = produce(session, 600)
    const outcome = await Promise.race([
      conn.closed.then((info) => info.code),
      producing.then(() => 'never closed'),
    ])
    assert.equal(outcome, 'never closed')
    assert.ok(session.emitQueueDepth <= 1, `queue depth ${session.emitQueueDepth}`)
    session.dispose()
  } finally {
    stop()
  }
})
