/**
 * A call's reply and a stream's elements are inbound to the side that called, so they meet
 * their `returns` and `yields` schemas on arrival, as a request meets its `payload` schema on
 * the responder. The responder's handler is typed, so each bad value below is cast past it:
 * the point is a peer the types do not bind.
 */
import { describe, expect, test } from 'bun:test'
import type { StandardSchemaV1 } from '@standard-schema/spec'
import { Client } from './client.ts'
import { defineContract, type MapOf, type$ } from './contract.ts'
import type { TransportError } from './errors.ts'
import { createServer } from './server.ts'
import { loopbackPair } from './transport/loopback.ts'

/** A minimal Standard Schema: `{ n: number }`. */
const counted: StandardSchemaV1<unknown, { n: number }> = {
  '~standard': {
    version: 1,
    vendor: 'test',
    validate: (value) =>
      typeof value === 'object' &&
      value !== null &&
      typeof (value as { n?: unknown }).n === 'number'
        ? { value: value as { n: number } }
        : { issues: [{ message: 'expected a number', path: ['n'] }] },
  },
}

const contract = defineContract({
  save: { lane: 'reliable', payload: type$<{ text: string }>(), returns: counted },
  count: { lane: 'reliable', payload: type$<{ from: number }>(), yields: counted },
  saveTyped: {
    lane: 'reliable',
    payload: type$<{ text: string }>(),
    returns: type$<{ n: number }>(),
  },
  countTyped: {
    lane: 'reliable',
    payload: type$<{ from: number }>(),
    yields: type$<{ n: number }>(),
  },
})
interface AppMap extends MapOf<typeof contract> {}

const bad = { n: 'not a number' } as unknown as { n: number }

async function until(cond: () => boolean, ms = 1000): Promise<void> {
  const deadline = Date.now() + ms
  while (!cond() && Date.now() < deadline) await new Promise((r) => setTimeout(r, 2))
}

async function rig(validateInbound?: boolean) {
  const server = createServer<AppMap>({ contract })
  await server.listen()
  const [serverSide, clientSide] = loopbackPair()
  const client = new Client<AppMap>({
    contract,
    connect: async () => clientSide,
    ...(validateInbound === undefined ? {} : { validateInbound }),
  })
  return {
    server,
    client,
    start: () => Promise.all([server.accept(serverSide), client.connect()]),
  }
}

describe('a call reply meets its returns schema', () => {
  test('a valid reply resolves', async () => {
    const { server, client, start } = await rig()
    server.handle('save', async () => ({ n: 3 }))
    await start()
    expect(await client.call('save', { text: 'x' })).toEqual({ n: 3 })
    client.disconnect()
  })

  test('a reply that fails its schema rejects with WT_VALIDATION_FAILED', async () => {
    const { server, client, start } = await rig()
    server.handle('save', async () => bad)
    await start()
    const error = (await client.call('save', { text: 'x' }).catch((e) => e)) as TransportError
    expect(error.code).toBe('WT_VALIDATION_FAILED')
    expect(error.message).toContain("field 'n'")
    client.disconnect()
  })

  test('validateInbound: false hands the reply over unchecked', async () => {
    const { server, client, start } = await rig(false)
    server.handle('save', async () => bad)
    await start()
    expect(await client.call('save', { text: 'x' })).toEqual(bad)
    client.disconnect()
  })

  test('a types-only returns slot checks nothing', async () => {
    const { server, client, start } = await rig()
    server.handle('saveTyped', async () => bad)
    await start()
    expect(await client.call('saveTyped', { text: 'x' })).toEqual(bad)
    client.disconnect()
  })
})

describe('a stream element meets its yields schema', () => {
  test('valid elements pass', async () => {
    const { server, client, start } = await rig()
    server.handle('count', async function* ({ from }) {
      for (let n = from; n < from + 3; n++) yield { n }
    })
    await start()
    const seen: { n: number }[] = []
    for await (const e of client.stream('count', { from: 1 })) seen.push(e)
    expect(seen).toEqual([{ n: 1 }, { n: 2 }, { n: 3 }])
    client.disconnect()
  })

  test('an element that fails throws WT_VALIDATION_FAILED, and the responder is cancelled', async () => {
    const { server, client, start } = await rig()
    let aborted = false
    let cleanedUp = false
    server.handle('count', async function* (_, ctx) {
      ctx.signal.addEventListener('abort', () => {
        aborted = true
      })
      try {
        yield { n: 1 }
        yield bad
        for (let n = 2; n < 1000; n++) yield { n }
      } finally {
        cleanedUp = true
      }
    })
    await start()
    const seen: { n: number }[] = []
    let error: TransportError | undefined
    try {
      for await (const e of client.stream('count', { from: 1 })) seen.push(e)
    } catch (e) {
      error = e as TransportError
    }
    expect(seen).toEqual([{ n: 1 }])
    expect(error?.code).toBe('WT_VALIDATION_FAILED')
    await until(() => aborted && cleanedUp)
    expect(aborted).toBe(true)
    expect(cleanedUp).toBe(true)
    client.disconnect()
  })

  test('validateInbound: false hands elements over unchecked', async () => {
    const { server, client, start } = await rig(false)
    server.handle('count', async function* () {
      yield bad
    })
    await start()
    const seen: unknown[] = []
    for await (const e of client.stream('count', { from: 1 })) seen.push(e)
    expect(seen).toEqual([bad])
    client.disconnect()
  })

  test('a types-only yields slot checks nothing', async () => {
    const { server, client, start } = await rig()
    server.handle('countTyped', async function* () {
      yield bad
    })
    await start()
    const seen: unknown[] = []
    for await (const e of client.stream('countTyped', { from: 1 })) seen.push(e)
    expect(seen).toEqual([bad])
    client.disconnect()
  })
})
