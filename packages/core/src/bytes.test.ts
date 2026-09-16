/**
 * `bytes()`: a payload that is a `Uint8Array` on both ends and bytes on the wire, under
 * codec 0x02, on every lane and every slot (D131). The last test is the norm: a frame whose
 * codec is not the one the contract declares for that slot is a protocol error, not a guess.
 */
import { describe, expect, test } from 'bun:test'
import { Client } from './client.ts'
import {
  buildEventTable,
  bytes,
  defineContract,
  type MapOf,
  reliable,
  rpc,
  streaming,
  type$,
  unreliable,
} from './contract.ts'
import type { TransportError } from './errors.ts'
import { createServer } from './server.ts'
import { Session } from './session.ts'
import { loopbackPair } from './transport/loopback.ts'

const contract = defineContract({
  blob: reliable(bytes()),
  frame: unreliable(bytes(), { fallback: 'newest' }),
  echo: rpc(bytes(), bytes()),
  chunksTyped: streaming(bytes(), bytes()),
  // A type in one slot and bytes in the other: the codec is per slot.
  mixed: rpc(type$<{ n: number }>(), bytes()),
})
interface AppMap extends MapOf<typeof contract> {}

const sample = (n: number): Uint8Array =>
  Uint8Array.from({ length: n }, (_, i) => (i * 7) & 0xff)

const wait = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms)
  })

async function pair(kind: 'webtransport' | 'websocket' = 'webtransport') {
  const [serverSide, clientSide] = loopbackPair(1200, kind)
  const server = createServer<AppMap>({ contract })
  server.handle('echo', async (payload) => Uint8Array.from(payload, (b) => b ^ 0xff))
  server.handle('chunksTyped', async function* (payload) {
    yield payload
    yield sample(3)
  })
  server.handle('mixed', async ({ n }) => sample(n))
  await server.listen()
  const client = new Client<AppMap>({ contract, connect: async () => clientSide })
  const [peer] = await Promise.all([server.accept(serverSide), client.connect()])
  return { server, client, peer }
}

describe('bytes on every lane', () => {
  test('a reliable emit arrives as the same bytes, both ways, and a broadcast too', async () => {
    const { server, client, peer } = await pair()
    const atServer: Uint8Array[] = []
    const atClient: Uint8Array[] = []
    peer.on('blob', (b) => atServer.push(b))
    client.on('blob', (b) => atClient.push(b))
    await peer.join('room')

    client.emit('blob', sample(300))
    peer.emit('blob', sample(5))
    await server.to('room').emit('blob', sample(9))
    await wait(20)

    expect(atServer.map((b) => [...b])).toEqual([[...sample(300)]])
    expect(atClient.map((b) => [...b])).toEqual([[...sample(5)], [...sample(9)]])
    expect(atServer[0]).toBeInstanceOf(Uint8Array)
    client.disconnect()
  })

  test('an unreliable emit crosses as a datagram, and wrapped on the fallback', async () => {
    for (const kind of ['webtransport', 'websocket'] as const) {
      const { client, peer } = await pair(kind)
      const got: Uint8Array[] = []
      peer.on('frame', (b) => got.push(b))
      client.emit('frame', sample(40))
      await wait(30)
      expect(got.map((b) => [...b])).toEqual([[...sample(40)]])
      client.disconnect()
    }
  })

  test('a call takes bytes and answers bytes', async () => {
    const { client } = await pair()
    const answer = await client.call('echo', sample(16))
    expect([...answer]).toEqual([...sample(16)].map((b) => b ^ 0xff))
    client.disconnect()
  })

  test('slots mix: a JSON payload with bytes back, and a stream of bytes', async () => {
    const { client } = await pair()
    expect([...(await client.call('mixed', { n: 6 }))]).toEqual([...sample(6)])
    const out: Uint8Array[] = []
    for await (const chunk of client.stream('chunksTyped', sample(2))) out.push(chunk)
    expect(out.map((b) => [...b])).toEqual([[...sample(2)], [...sample(3)]])
    client.disconnect()
  })

  test('the value handed to the application is a copy, not a view into the decoder', async () => {
    const { client, peer } = await pair()
    const got: Uint8Array[] = []
    peer.on('blob', (b) => got.push(b))
    client.emit('blob', sample(10))
    client.emit('blob', sample(20))
    await wait(20)
    expect(got[0]?.byteOffset).toBe(0)
    expect(got[0]?.buffer.byteLength).toBe(10)
    client.disconnect()
  })

  test('sending anything but a Uint8Array to a bytes event fails before the wire', async () => {
    const { client } = await pair()
    expect(() => client.emit('blob', 'text' as never)).toThrow(/declared bytes\(\)/)
    client.disconnect()
  })

  test('with validation on, a bytes slot refuses a JSON value at the door', async () => {
    const table = await buildEventTable(contract)
    expect(await contract.blob.payload['~standard'].validate('no')).toMatchObject({
      issues: [{ message: expect.stringContaining('Uint8Array') }],
    })
    expect(table.byName('blob')?.def.payload).toBe(contract.blob.payload)
  })
})

// norm: codec-matches-the-slot
describe('the wire and the contract must agree on the codec', () => {
  test('a JSON frame for an event this side declares bytes is a protocol error that names the slot', async () => {
    // Two contracts that agree on names and lanes and disagree on the codec of `blob`.
    const theirs = defineContract({ blob: reliable<{ x: number }>() })
    const [a, b] = loopbackPair()
    const sessionA = new Session(a, { table: await buildEventTable(theirs), origin: 1 })
    const sessionB = new Session(b, { table: await buildEventTable(contract), origin: 2 })
    await Promise.all([sessionA.start(), sessionB.start()])
    let seen: unknown = 'nothing'
    sessionB.on('blob', (v) => {
      seen = v
    })
    sessionA.emit('blob', { x: 1 })
    const info = await b.closed
    expect(seen).toBe('nothing')
    expect(info.reason).toContain("event 'blob' declares bytes for its payload")
    expect(info.reason).toContain('carries JSON')
  })

  test('a codec byte outside the two this version speaks is refused as unsupported', async () => {
    const { decodeDatagram } = await import('./datagram.ts')
    const raw = new Uint8Array(14)
    raw[0] = 0x03
    raw[4] = 1
    raw[13] = 9
    expect(() => decodeDatagram(raw)).toThrow(/not supported/)
    let code = ''
    try {
      decodeDatagram(raw)
    } catch (e) {
      code = (e as TransportError).code
    }
    expect(code).toBe('WT_UNSUPPORTED_CODEC')
  })
})
