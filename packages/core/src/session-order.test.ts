/**
 * `onSession` runs before anything from that session reaches application code (D146).
 *
 * An application could not find out, so it did not depend on it: its server sends history as
 * one replacing event, where a client could have cleared its state in `onSession`. Measured
 * before this was a guarantee: over the loopback `onSession` ran first, and with the peer's
 * handshake and its first emit arriving in one read, which a real network is free to do
 * since a stream keeps no write boundaries, the event reached its handler first. Both ends
 * now hold what the peer sent after its handshake until their `onSession` callbacks return.
 */
import { describe, expect, test } from 'bun:test'
import { Client } from './client.ts'
import { encodePayload } from './codec.ts'
import { buildEventTable, defineContract, type MapOf, reliable } from './contract.ts'
import { encodeFrame } from './framer.ts'
import { buildHandshake } from './handshake.ts'
import { Codec, EVENT_ID_NOT_APPLICABLE, FrameType } from './protocol.ts'
import { createServer } from './server.ts'
import { loopbackPair } from './transport/loopback.ts'
import type { Connection } from './transport/types.ts'

const contract = defineContract({ line: reliable<{ n: number }>() })
interface AppMap extends MapOf<typeof contract> {}

const wait = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms)
  })

/**
 * A peer whose handshake and first two emits arrive as one chunk: the worst case a stream
 * allows, and the one the loopback never produces.
 */
async function peerInOneRead(): Promise<Connection> {
  const table = await buildEventTable(contract)
  const entry = table.byName('line')
  if (entry === undefined) throw new Error('the contract has no line event')
  const frames = [
    encodeFrame({
      type: FrameType.HANDSHAKE,
      codec: Codec.JSON,
      eventId: EVENT_ID_NOT_APPLICABLE,
      payload: encodePayload(buildHandshake(table)),
    }),
    ...[1, 2].map((n) =>
      encodeFrame({
        type: FrameType.EMIT,
        codec: Codec.JSON,
        eventId: entry.id,
        payload: encodePayload({ n }),
      }),
    ),
  ]
  const chunk = new Uint8Array(frames.reduce((sum, f) => sum + f.byteLength, 0))
  let at = 0
  for (const f of frames) {
    chunk.set(f, at)
    at += f.byteLength
  }
  const [, side] = loopbackPair()
  return Object.assign(Object.create(side) as Connection, {
    onEmitStream: (cb: (r: ReadableStream<Uint8Array>) => void) => {
      cb(
        new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(chunk)
          },
        }),
      )
    },
    openEmitStream: async () => new WritableStream<Uint8Array>(),
    onBidi: () => undefined,
    onDatagram: () => undefined,
    closed: new Promise<never>(() => undefined),
    kind: () => 'webtransport' as const,
    reliability: () => undefined,
    close: () => undefined,
  })
}

describe('the client', () => {
  test('onSession runs before the first event, even when both arrive in one read', async () => {
    for (const validateInbound of [true, false]) {
      const conn = await peerInOneRead()
      const client = new Client<AppMap>({
        contract,
        connect: async () => conn,
        validateInbound,
      })
      const order: string[] = []
      client.onSession(() => order.push('session'))
      client.on('line', ({ n }) => order.push(`line:${n}`))
      await client.connect()
      await wait(10)
      expect(order).toEqual(['session', 'line:1', 'line:2'])
      client.disconnect()
    }
  })

  test('what onSession does before its first await is done before the first event', async () => {
    const conn = await peerInOneRead()
    const client = new Client<AppMap>({ contract, connect: async () => conn })
    let board: number[] = [99]
    client.onSession(async () => {
      board = [] // cleared for the new session, synchronously
      await wait(5)
      board.push(-1) // after an await: not ordered against events
    })
    client.on('line', ({ n }) => board.push(n))
    await client.connect()
    await wait(20)
    expect(board).toEqual([1, 2, -1])
    client.disconnect()
  })

  test('a callback that throws does not leave the session holding', async () => {
    const conn = await peerInOneRead()
    const client = new Client<AppMap>({ contract, connect: async () => conn })
    const seen: number[] = []
    client.onSession(() => {
      throw new Error('an application bug')
    })
    client.on('line', ({ n }) => seen.push(n))
    await client.connect().catch(() => undefined)
    await wait(10)
    expect(seen).toEqual([1, 2])
    client.disconnect()
  })

  test('over the loopback too, with a server that emits from its own onSession', async () => {
    const [serverSide, clientSide] = loopbackPair()
    const server = createServer<AppMap>({ contract })
    await server.listen()
    server.onSession((peer) => peer.emit('line', { n: 1 }))
    const client = new Client<AppMap>({ contract, connect: async () => clientSide })
    const order: string[] = []
    client.onSession(() => order.push('session'))
    client.on('line', () => order.push('line'))
    await Promise.all([server.accept(serverSide), client.connect()])
    await wait(10)
    expect(order).toEqual(['session', 'line'])
    client.disconnect()
  })
})

describe('the server', () => {
  test('a handler registered in onSession receives a first event that came with the handshake', async () => {
    const conn = await peerInOneRead()
    const server = createServer<AppMap>({ contract })
    await server.listen()
    const seen: number[] = []
    server.onSession((peer) => {
      peer.on('line', ({ n }) => seen.push(n))
    })
    await server.accept(conn)
    await wait(10)
    expect(seen).toEqual([1, 2])
  })
})
