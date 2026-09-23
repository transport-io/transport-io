/**
 * `onSession` and opt-in reconnect (D133): the two things the reconnect guide asked every
 * application to write, the edge into `connected` and the guard against two attempts
 * overlapping, now inside the client. A reconnect is still a new session, so every one of
 * them runs `onSession`, and every attempt starts from the native connector again.
 */
import { describe, expect, test } from 'bun:test'
import { Client, type ClientState } from './client.ts'
import { defineContract, type MapOf, reliable } from './contract.ts'
import { TransportError } from './errors.ts'
import { CloseCode } from './protocol.ts'
import { createServer, type ServerPeer } from './server.ts'
import { loopbackPair } from './transport/loopback.ts'

const contract = defineContract({ chat: reliable<{ body: string }>() })
interface AppMap extends MapOf<typeof contract> {}

const wait = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms)
  })

/** A server that accepts a fresh loopback pair on every connect, and remembers each peer. */
async function farEnd() {
  const server = createServer<AppMap>({ contract })
  await server.listen()
  const peers: ServerPeer<AppMap>[] = []
  const connects: number[] = []
  const connect = async () => {
    connects.push(Date.now())
    const [serverSide, clientSide] = loopbackPair()
    void server.accept(serverSide).then((p) => peers.push(p))
    return clientSide
  }
  return { server, peers, connects, connect }
}

describe('onSession', () => {
  test('runs once per session with the connected snapshot, and unsubscribes', async () => {
    const { peers, connect } = await farEnd()
    const client = new Client<AppMap>({ contract, connect })
    const seen: ClientState[] = []
    const stop = client.onSession((s) => seen.push(s))
    await client.connect()
    await wait(10)
    expect(seen).toHaveLength(1)
    expect(seen[0]?.status).toBe('connected')
    expect(seen[0]?.transport).toBe('webtransport')

    // A second session, by the application's own hand.
    client.disconnect()
    await client.connect()
    await wait(10)
    expect(seen).toHaveLength(2)
    expect(peers).toHaveLength(2)

    stop()
    client.disconnect()
    await client.connect()
    await wait(10)
    expect(seen).toHaveLength(2)
    client.disconnect()
  })
})

describe('reconnect', () => {
  test('is off unless asked for: a dropped session stays closed', async () => {
    const { peers, connect, connects } = await farEnd()
    const client = new Client<AppMap>({ contract, connect })
    await client.connect()
    await wait(10)
    peers[0]?.close(CloseCode.WT_NO_ERROR, 'server side')
    await wait(60)
    expect(client.getSnapshot().status).toBe('closed')
    expect(connects).toHaveLength(1)
    client.disconnect()
  })

  test('a dropped session comes back on its own, as a new session that runs onSession', async () => {
    const { peers, connect, connects } = await farEnd()
    const client = new Client<AppMap>({
      contract,
      connect,
      reconnect: { minMs: 10, maxMs: 40 },
    })
    const sessions: string[] = []
    client.onSession((s) => sessions.push(s.sessionId ?? ''))
    await client.connect()
    await wait(10)
    peers[0]?.close(CloseCode.WT_NO_ERROR, 'server side')
    await wait(5)
    expect(client.getSnapshot().status).toBe('closed')
    await wait(60)
    expect(client.getSnapshot().status).toBe('connected')
    expect(connects).toHaveLength(2)
    expect(sessions).toHaveLength(2)
    expect(peers).toHaveLength(2)
    client.disconnect()
  })

  test('the wait doubles from minMs to maxMs across failed attempts, then resets', async () => {
    let failures = 4
    const far = await farEnd()
    const attempts: number[] = []
    const connect = async () => {
      attempts.push(Date.now())
      if (attempts.length > 1 && failures > 0) {
        failures--
        throw new TransportError('WT_HANDSHAKE_FAILED', 'down', 'stub')
      }
      return far.connect()
    }
    const client = new Client<AppMap>({
      contract,
      connect,
      reconnect: { minMs: 20, maxMs: 80 },
    })
    await client.connect()
    await wait(10)
    far.peers[0]?.close(CloseCode.WT_NO_ERROR, 'server side')
    await wait(600)
    expect(client.getSnapshot().status).toBe('connected')
    // Six connects: the first, four failures, the one that came back.
    expect(attempts).toHaveLength(6)
    const gaps = attempts.slice(2).map((t, i) => t - (attempts[i + 1] ?? 0))
    // Each wait is between half its base and the base: 20, 40, 80, 80.
    expect(gaps[0]).toBeGreaterThanOrEqual(9)
    expect(gaps[1]).toBeGreaterThanOrEqual(19)
    expect(gaps[2]).toBeGreaterThanOrEqual(39)
    expect(gaps[3]).toBeGreaterThanOrEqual(39)
    expect(Math.max(...gaps)).toBeLessThanOrEqual(120)
    client.disconnect()
  })

  test("a connect that throws its own error is retried, with it on lastError's cause", async () => {
    // The deploying guide's shape: `connect` fetches a token first and throws when the
    // endpoint refuses, which is not a transport failure and not a refusal from `authorize`.
    let signedOut = 2
    const far = await farEnd()
    const thrown: Error[] = []
    const connect = async () => {
      if (far.connects.length > 0 && signedOut > 0) {
        signedOut--
        const e = new Error('/api/session answered 401')
        thrown.push(e)
        throw e
      }
      return far.connect()
    }
    const client = new Client<AppMap>({
      contract,
      connect,
      reconnect: { minMs: 10, maxMs: 20 },
    })
    const errors: unknown[] = []
    client.subscribe(() => {
      const e = client.getSnapshot().lastError
      if (e !== null && !errors.includes(e)) errors.push(e)
    })
    await client.connect()
    await wait(10)
    far.peers[0]?.close(CloseCode.WT_NO_ERROR, 'server side')
    await wait(150)

    expect(client.getSnapshot().status).toBe('connected')
    // The drop itself has no error, so each one here is a throw from `connect`.
    expect(errors).toHaveLength(2)
    for (const [i, e] of errors.entries()) {
      expect((e as TransportError).code).toBe('WT_SESSION_CLOSED')
      expect((e as TransportError).cause).toBe(thrown[i])
    }
    client.disconnect()
  })

  test('disconnect() stops a reconnect that is waiting, and none follow', async () => {
    const { peers, connect, connects } = await farEnd()
    const client = new Client<AppMap>({
      contract,
      connect,
      reconnect: { minMs: 30, maxMs: 30 },
    })
    await client.connect()
    await wait(10)
    peers[0]?.close(CloseCode.WT_NO_ERROR, 'server side')
    await wait(5)
    client.disconnect()
    await wait(100)
    expect(connects).toHaveLength(1)
    expect(client.getSnapshot().status).toBe('closed')
  })

  test('the first connect() is not retried: it rejects, and nothing follows', async () => {
    let calls = 0
    const connect = async () => {
      calls++
      throw new TransportError('WT_HANDSHAKE_FAILED', 'down', 'stub')
    }
    const client = new Client<AppMap>({ contract, connect, reconnect: { minMs: 5, maxMs: 10 } })
    await expect(client.connect()).rejects.toMatchObject({ code: 'WT_HANDSHAKE_FAILED' })
    await wait(60)
    expect(calls).toBe(1)
    client.disconnect()
  })

  test('two attempts never overlap: a connect() during the wait is the one that runs', async () => {
    const { peers, connect, connects } = await farEnd()
    const client = new Client<AppMap>({
      contract,
      connect,
      reconnect: { minMs: 40, maxMs: 40 },
    })
    await client.connect()
    await wait(10)
    peers[0]?.close(CloseCode.WT_NO_ERROR, 'server side')
    await wait(5)
    // The application reconnects by hand while the timer is pending. The refcount goes to two.
    await client.connect()
    await wait(80)
    expect(connects).toHaveLength(2)
    expect(client.getSnapshot().status).toBe('connected')
    client.disconnect()
    client.disconnect()
  })
})
