/**
 * A refusal, end to end (D144). `authorize` says why, the reason travels as the close
 * reason and so is capped where it is made, the client gets a `RefusedError` and a `refused`
 * state beside `closed`, and a client that reconnects on its own stops, because the same
 * request would be refused again. A throw from `authorize` is not a refusal and stays
 * retryable. And the order Chromium delivers a refusal in, measured: the stream being opened
 * fails first and `closed` says why a moment later.
 */
import { describe, expect, test } from 'bun:test'
import { decide, refuse } from './authorize.ts'
import { Client } from './client.ts'
import { defineContract, type MapOf, reliable } from './contract.ts'
import { RefusedError, type TransportError } from './errors.ts'
import { CloseCode, REFUSAL_REASON_MAX_BYTES, WS_CLOSE_REASON_MAX_BYTES } from './protocol.ts'
import { createServer, type ServerPeer } from './server.ts'
import { loopbackPair } from './transport/loopback.ts'
import type { Authorize, Connection, ConnectRequest } from './transport/types.ts'

const contract = defineContract({ chat: reliable<{ body: string }>() })
interface AppMap extends MapOf<typeof contract> {}

const wait = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms)
  })

const failed = (p: Promise<unknown>): Promise<TransportError> =>
  p.then(
    () => {
      throw new Error('expected a rejection')
    },
    (e: unknown) => e as TransportError,
  )

const request = (token: string): ConnectRequest => ({
  path: '/',
  query: new URLSearchParams({ token }),
  peerAddress: '127.0.0.1:1',
  headers: {},
})

/** A door over loopback pairs: what a listener does with a verdict, with no listener. */
async function door<D>(authorize: Authorize<D>) {
  const server = createServer<AppMap, D>({ contract })
  await server.listen()
  const peers: ServerPeer<AppMap, D>[] = []
  const dials: string[] = []
  const connectWith = (token: () => string) => async (): Promise<Connection> => {
    const t = token()
    dials.push(t)
    const [serverSide, clientSide] = loopbackPair()
    const verdict = await decide(authorize, () => request(t))
    if (verdict.accepted) {
      void server
        .accept(Object.assign(serverSide, { data: verdict.data as D }))
        .then((p) => peers.push(p))
    } else {
      serverSide.close(verdict.code, verdict.reason)
    }
    return clientSide
  }
  return { server, peers, dials, connectWith }
}

describe('refuse(reason)', () => {
  // norm: refusal-reason-123-bytes
  test('a reason is 1 to 123 bytes, refused where it is made and never cut on the wire', () => {
    // The cap is the smaller mapping's, so a reason is never cut on either.
    expect(REFUSAL_REASON_MAX_BYTES).toBe(WS_CLOSE_REASON_MAX_BYTES)
    expect(refuse('expired').reason).toBe('expired')
    expect(refuse('x'.repeat(REFUSAL_REASON_MAX_BYTES)).reason).toHaveLength(123)
    expect(() => refuse('')).toThrow(/1 to 123 bytes/)
    expect(() => refuse('x'.repeat(124))).toThrow(/WT_VALIDATION_FAILED/)
    // Bytes, not characters: 62 two-byte characters are 124 bytes.
    expect(() => refuse('é'.repeat(62))).toThrow(/this one is 124/)
  })
})

describe('the verdict', () => {
  test('null and refuse() are refusals, a value is accepted, a throw is neither', async () => {
    expect(await decide(undefined, () => request('x'))).toEqual({
      accepted: true,
      data: undefined,
    })
    expect(
      await decide(
        () => ({ user: 'ann' }),
        () => request('x'),
      ),
    ).toEqual({
      accepted: true,
      data: { user: 'ann' },
    })
    expect(
      await decide(
        () => null,
        () => request('x'),
      ),
    ).toEqual({
      accepted: false,
      code: CloseCode.WT_UNAUTHORIZED,
      reason: 'refused',
    })
    expect(
      await decide(
        async () => refuse('expired'),
        () => request('x'),
      ),
    ).toEqual({
      accepted: false,
      code: CloseCode.WT_UNAUTHORIZED,
      reason: 'expired',
    })
    const thrown = await decide(
      () => {
        throw new Error('the user database is down')
      },
      () => request('x'),
    )
    // Not WT_UNAUTHORIZED, which a client treats as final, and nothing of the error's text.
    expect(thrown).toEqual({
      accepted: false,
      code: CloseCode.WT_NO_ERROR,
      reason: 'authorize failed',
    })
  })
})

describe('a refused client', () => {
  test('connect() rejects with a RefusedError, and the snapshot says refused beside closed', async () => {
    const { connectWith } = await door(({ query }) =>
      query.get('token') === 'good' ? { user: 'ann' } : refuse('expired'),
    )
    const client = new Client<AppMap>({ contract, connect: connectWith(() => 'stale') })
    const err = await failed(client.connect())
    expect(err).toBeInstanceOf(RefusedError)
    expect(err.code).toBe('WT_UNAUTHORIZED')
    expect((err as RefusedError).reason).toBe('expired')

    const state = client.getSnapshot()
    expect(state.status).toBe('closed')
    expect(state.refused).toEqual({ reason: 'expired' })
    expect(state.lastError).toBe(err)
    // No session was left behind to swallow an emit.
    expect(() => client.emit('chat', { body: 'x' })).toThrow(/WT_SESSION_CLOSED/)
    client.disconnect()
  })

  test('authorize returning null is the reason "refused"', async () => {
    const { connectWith } = await door(() => null)
    const client = new Client<AppMap>({ contract, connect: connectWith(() => 'any') })
    const err = await failed(client.connect())
    expect((err as RefusedError).reason).toBe('refused')
    expect(client.getSnapshot().refused).toEqual({ reason: 'refused' })
    client.disconnect()
  })

  test('the order Chromium delivers it in: the stream fails first, closed says why after', async () => {
    const [serverSide, clientSide] = loopbackPair()
    const chromium: Connection = Object.assign(Object.create(clientSide) as Connection, {
      openEmitStream: () => Promise.reject(new Error('The session is closed.')),
      closed: wait(20).then(() => ({ code: CloseCode.WT_UNAUTHORIZED, reason: 'expired' })),
      onEmitStream: () => undefined,
      onBidi: () => undefined,
      onDatagram: () => undefined,
      kind: () => 'webtransport' as const,
      reliability: () => undefined,
      close: () => undefined,
    })
    void serverSide
    const client = new Client<AppMap>({ contract, connect: async () => chromium })
    const err = await failed(client.connect())
    expect(err).toBeInstanceOf(RefusedError)
    expect((err as RefusedError).reason).toBe('expired')
    client.disconnect()
  })

  test('a stream that fails with no close to explain it is WT_SESSION_CLOSED, after a bounded wait', async () => {
    const [, clientSide] = loopbackPair()
    const silent: Connection = Object.assign(Object.create(clientSide) as Connection, {
      openEmitStream: () => Promise.reject(new Error('The session is closed.')),
      closed: new Promise<never>(() => undefined),
      onEmitStream: () => undefined,
      onBidi: () => undefined,
      onDatagram: () => undefined,
      kind: () => 'webtransport' as const,
      reliability: () => undefined,
      close: () => undefined,
    })
    const client = new Client<AppMap>({ contract, connect: async () => silent })
    const started = Date.now()
    const err = await failed(client.connect())
    expect(err.code).toBe('WT_SESSION_CLOSED')
    expect(err.message).toContain('The session is closed.')
    expect(Date.now() - started).toBeLessThan(1_000)
    expect(client.getSnapshot().refused).toBeNull()
    client.disconnect()
  })
})

describe('reconnect and a refusal', () => {
  // norm: refusal-is-final
  test('a refusal is final: the loop stops, and disconnect() then connect() starts over', async () => {
    let valid = 'first'
    let token = 'first'
    const { peers, dials, connectWith } = await door(({ query }) =>
      query.get('token') === valid ? { user: 'ann' } : refuse('expired'),
    )
    const client = new Client<AppMap>({
      contract,
      connect: connectWith(() => token),
      reconnect: { minMs: 5, maxMs: 10 },
    })
    await client.connect()
    await wait(10)

    // The token stops being valid, and the session drops.
    valid = 'second'
    peers[0]?.close(CloseCode.WT_NO_ERROR, 'restart')
    await wait(150)
    // One reconnect attempt, refused, and no second: fifteen waits of 10 ms went by.
    expect(dials).toEqual(['first', 'first'])
    const state = client.getSnapshot()
    expect(state.status).toBe('closed')
    expect(state.refused).toEqual({ reason: 'expired' })

    // The application's way out: a credential that will pass, then a fresh attempt.
    token = 'second'
    client.disconnect()
    await client.connect()
    expect(client.getSnapshot().status).toBe('connected')
    expect(client.getSnapshot().refused).toBeNull()
    expect(client.getSnapshot().lastError).toBeNull()
    client.disconnect()
  })

  // norm: undecided-is-not-a-refusal
  test('an authorize that throws is not final: the loop keeps trying, and recovers', async () => {
    let down = false
    const { peers, dials, connectWith } = await door(() => {
      if (down) throw new Error('the user database is down')
      return { user: 'ann' }
    })
    const client = new Client<AppMap>({
      contract,
      connect: connectWith(() => 't'),
      reconnect: { minMs: 5, maxMs: 10 },
    })
    await client.connect()
    await wait(10)
    // Recorded as they happen: a sample taken between attempts races the next `connecting`,
    // which clears `lastError`.
    const errors: string[] = []
    let everRefused = false
    client.subscribe(() => {
      const state = client.getSnapshot()
      if (state.lastError !== null) errors.push(state.lastError.message)
      if (state.refused !== null) everRefused = true
    })
    down = true
    peers[0]?.close(CloseCode.WT_NO_ERROR, 'restart')
    await wait(80)
    expect(dials.length).toBeGreaterThan(3)
    expect(everRefused).toBe(false)
    expect(errors.length).toBeGreaterThan(1)
    for (const message of errors) {
      expect(message).toContain('WT_SESSION_CLOSED')
      expect(message).toContain('authorize failed')
    }
    down = false
    await wait(60)
    expect(client.getSnapshot().status).toBe('connected')
    client.disconnect()
  })

  test('a live session the server closes as WT_UNAUTHORIZED is a refusal too, and final', async () => {
    const { peers, dials, connectWith } = await door(() => ({ user: 'ann' }))
    const client = new Client<AppMap>({
      contract,
      connect: connectWith(() => 't'),
      reconnect: { minMs: 5, maxMs: 10 },
    })
    await client.connect()
    await wait(10)
    peers[0]?.close(CloseCode.WT_UNAUTHORIZED, 'signed-out')
    await wait(80)
    expect(dials).toHaveLength(1)
    expect(client.getSnapshot().status).toBe('closed')
    expect(client.getSnapshot().refused).toEqual({ reason: 'signed-out' })
    expect(client.getSnapshot().lastError).toBeInstanceOf(RefusedError)
    client.disconnect()
  })

  test('a session closed on any other error leaves that error in lastError, and is not a refusal', async () => {
    const { peers, dials, connectWith } = await door(() => ({ user: 'ann' }))
    const client = new Client<AppMap>({ contract, connect: connectWith(() => 't') })
    await client.connect()
    await wait(10)
    peers[0]?.close(CloseCode.WT_PEER_TOO_SLOW, 'queue full')
    await wait(30)
    const state = client.getSnapshot()
    expect(state.status).toBe('closed')
    expect(state.lastError?.code).toBe('WT_PEER_TOO_SLOW')
    expect(state.lastError?.message).toContain('queue full')
    expect(state.refused).toBeNull()
    expect(dials).toHaveLength(1)
    client.disconnect()
  })
})
