import { describe, expect, test } from 'bun:test'
import { Client } from './client.ts'
import { defineContract, type MapOf, type$ } from './contract.ts'
import { TransportError } from './errors.ts'
import { MAX_CONCURRENT_CALL_STREAMS } from './protocol.ts'
import { createServer, type Server } from './server.ts'
import { loopbackPair } from './transport/loopback.ts'

const contract = defineContract({
  chat: { lane: 'stream', payload: type$<{ body: string }>() },
  save: {
    lane: 'stream',
    payload: type$<{ docId: string; text: string }>(),
    returns: type$<{ revision: number }>(),
  },
  slow: { lane: 'stream', payload: type$<{ ms: number }>(), returns: type$<{ done: true }>() },
  boom: { lane: 'stream', payload: type$<null>(), returns: type$<null>() },
})
interface AppMap extends MapOf<typeof contract> {}

async function wire(): Promise<{ server: Server<AppMap>; client: Client<AppMap> }> {
  const server = createServer<AppMap>({ contract })
  await server.listen()
  const [serverSide, clientSide] = loopbackPair()
  const client = new Client<AppMap>({ contract, connect: async () => clientSide })
  await Promise.all([server.accept(serverSide), client.connect()])
  return { server, client }
}

describe('call: the stream is the correlation', () => {
  test('request and response round-trip with no correlation id', async () => {
    const { server, client } = await wire()
    server.handle('save', async ({ text }) => ({ revision: text.length }))
    expect(await client.call('save', { docId: 'a', text: 'hello' })).toEqual({ revision: 5 })
  })

  test('concurrent calls do not queue behind each other', async () => {
    const { server, client } = await wire()
    const release: (() => void)[] = []
    server.handle('slow', async () => {
      await new Promise<void>((r) => release.push(r))
      return { done: true as const }
    })

    const a = client.call('slow', { ms: 0 })
    const b = client.call('slow', { ms: 0 })
    const c = client.call('slow', { ms: 0 })
    await new Promise((r) => setTimeout(r, 20))
    expect(release.length).toBe(3) // all three are in flight, none blocked

    // Resolve out of order: a stalled call cannot hold up another.
    release[2]?.()
    release[0]?.()
    release[1]?.()
    expect(await Promise.all([a, b, c])).toEqual([
      { done: true },
      { done: true },
      { done: true },
    ])
  })

  test('a handler that throws produces a CALL_ERROR with its code', async () => {
    const { server, client } = await wire()
    server.handle('boom', async () => {
      throw new TransportError('WT_VALIDATION_FAILED', 'field bad', 'Fix the payload.')
    })
    try {
      await client.call('boom', null)
      throw new Error('expected a throw')
    } catch (e) {
      expect((e as TransportError).code).toBe('WT_VALIDATION_FAILED')
      expect((e as TransportError).message).toContain('field bad')
    }
  })

  test('calling an event with no handler is an error, not a hang', async () => {
    const { client } = await wire()
    await expect(client.call('save', { docId: 'a', text: 'b' })).rejects.toThrow(TransportError)
  })

  test('an unknown event is refused locally, before opening a stream', async () => {
    const { client } = await wire()
    // @ts-expect-error not in the contract
    await expect(client.call('nope', {})).rejects.toThrow(TransportError)
  })

  test('an event declaring no `returns` is refused by name, not as a missing handler', async () => {
    const { client } = await wire()
    // Was a bare `.rejects.toThrow()` on the same WT_UNKNOWN_EVENT path as the test above,
    // so it asserted nothing the neighbour did not. The two faults have different remedies
    // — add `returns` to the contract, versus register a handler — so the message has to
    // say which one this is.
    // @ts-expect-error 'chat' declares no `returns`
    await expect(client.call('chat', { body: 'x' })).rejects.toThrow(/declares no/)
  })
})

describe('call: abort maps to a stream reset', () => {
  test('an already-aborted signal throws before any stream is opened', async () => {
    const { client } = await wire()
    const ac = new AbortController()
    ac.abort()
    await expect(
      client.call('save', { docId: 'a', text: 'b' }, { signal: ac.signal }),
    ).rejects.toThrow()
  })

  test('aborting mid-flight rejects the caller and frees the stream slot', async () => {
    const { server, client } = await wire()
    let released!: () => void
    server.handle('slow', async () => {
      await new Promise<void>((r) => {
        released = r
      })
      return { done: true as const }
    })

    const ac = new AbortController()
    const pending = client.call('slow', { ms: 0 }, { signal: ac.signal })
    await new Promise((r) => setTimeout(r, 20))
    ac.abort()

    await expect(pending).rejects.toThrow()
    released() // the handler completing afterwards must not resurrect the call
    await new Promise((r) => setTimeout(r, 20))
  })

  test('AbortSignal.timeout is the documented idiom, since there is no default timeout', async () => {
    const { server, client } = await wire()
    server.handle('slow', async () => {
      await new Promise<void>(() => undefined) // never resolves
      return { done: true as const }
    })
    await expect(
      client.call('slow', { ms: 0 }, { signal: AbortSignal.timeout(60) }),
    ).rejects.toThrow()
  })
})

describe('call: the concurrent stream cap', () => {
  // Renamed. The old name — "the 257th open is refused" — read as the §10.1 receiver-side
  // refusal, which this does not exercise: it drives the cap through `client.call()`, so
  // the refusal is this side's own, before a stream is ever opened. The receiver half is
  // asserted in protocol-promises.test.ts, which is where WT_TOO_MANY_STREAMS is observed
  // on the wire. Both halves are real; only one of them was ever tested.
  test('this side declines to open a 257th call stream, and the session stays up', async () => {
    const { server, client } = await wire()
    const release: (() => void)[] = []
    server.handle('slow', async () => {
      await new Promise<void>((r) => release.push(r))
      return { done: true as const }
    })

    const inflight: Promise<unknown>[] = []
    for (let i = 0; i < MAX_CONCURRENT_CALL_STREAMS; i++) {
      inflight.push(client.call('slow', { ms: 0 }).catch(() => undefined))
    }
    await new Promise((r) => setTimeout(r, 50))

    try {
      await client.call('slow', { ms: 0 })
      throw new Error('expected a throw')
    } catch (e) {
      expect((e as TransportError).code).toBe('WT_TOO_MANY_STREAMS')
      // D18's whole purpose: a leaking handler must not take the session down with it.
      expect((e as TransportError).remedy).toContain('session stays open')
    }
    expect(client.getSnapshot().status).toBe('connected')

    for (const r of release) r()
    await Promise.all(inflight)
  })
})
