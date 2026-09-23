/**
 * Whatever is thrown between `connect()` and the handshake rejects `connect()` and is in
 * `lastError`, and says what it is. See D156.
 *
 * A page that was not a secure context threw a `TypeError` while building the event table.
 * It did reach `lastError`, but as `WT_SESSION_CLOSED` with the remedy "Retry the
 * connection." and the `TypeError` itself dropped, which reads as a network session that
 * ended and would have thrown the same `TypeError` on every retry.
 */
import { describe, expect, test } from 'bun:test'
import { Client } from './client.ts'
import { defineContract, type MapOf, reliable } from './contract.ts'
import type { TransportError } from './errors.ts'
import { createServer } from './server.ts'
import { loopbackPair } from './transport/loopback.ts'
import type { Connection } from './transport/types.ts'

const contract = defineContract({ chat: reliable<{ body: string }>() })
interface AppMap extends MapOf<typeof contract> {}

const rejection = (p: Promise<unknown>): Promise<TransportError> =>
  p.then(
    () => {
      throw new Error('expected a rejection')
    },
    (e: unknown) => e as TransportError,
  )

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

describe('a throw before the handshake', () => {
  test('keeps what was thrown on `cause`, and the remedy points at it', async () => {
    const thrown = new TypeError('not a transport failure')
    const client = new Client<AppMap>({ contract, connect: () => Promise.reject(thrown) })

    const err = await rejection(client.connect())
    expect(err.code).toBe('WT_SESSION_CLOSED')
    expect(err.cause).toBe(thrown)
    expect(err.message).toContain('TypeError: not a transport failure')
    expect(err.remedy).toContain('`cause`')
    expect(err.remedy).not.toMatch(/retry/i)
    expect(client.getSnapshot().status).toBe('closed')
    expect(client.getSnapshot().lastError).toBe(err)
  })

  test('a subscriber that throws on the first write still leaves the attempt in lastError', async () => {
    const client = new Client<AppMap>({
      contract,
      connect: () => Promise.reject(new Error('never reached')),
    })
    let writes = 0
    client.subscribe(() => {
      if (writes++ === 0) throw new Error('the subscriber threw')
    })

    const err = await rejection(client.connect())
    expect((err.cause as Error).message).toBe('the subscriber threw')
    // It was left at `connecting`, with no `lastError`, for as long as the page was open.
    expect(client.getSnapshot().status).toBe('closed')
    expect(client.getSnapshot().lastError).toBe(err)
  })
})

describe('an attempt superseded by disconnect() and a newer connect()', () => {
  test('fails without writing over the newer attempt, and without clearing it', async () => {
    const server = createServer<AppMap>({ contract })
    await server.listen()
    let attempts = 0
    const connect = async (): Promise<Connection> => {
      attempts++
      if (attempts === 1) {
        await sleep(20)
        throw new TypeError('the first attempt failed')
      }
      await sleep(80)
      const [serverSide, clientSide] = loopbackPair()
      void server.accept(serverSide).catch(() => undefined)
      return clientSide
    }
    const client = new Client<AppMap>({ contract, connect })

    // The StrictMode shape: mount, unmount, mount, with the first attempt still in flight.
    const first = client.connect()
    client.disconnect()
    const second = client.connect()

    await rejection(first)
    // The first attempt's failure was written over the second, still connecting.
    expect(client.getSnapshot().status).toBe('connecting')
    expect(client.getSnapshot().lastError).toBeNull()

    // And `connect()` cleared the second attempt as it rejected, so a third started another.
    const third = client.connect()
    await Promise.all([second, third])
    expect(attempts).toBe(2)
    expect(client.getSnapshot().status).toBe('connected')
    client.disconnect()
    client.disconnect()
  })
})
