/**
 * Four places where the public API's promise and its behaviour parted company.
 *
 * Each is small on its own. Together they are the same failure as D69 at the API layer:
 * the documented thing is what a caller reads, and nothing asserted the documented thing.
 */
/**
 * Proves these normative statements, which name this file back. The link is checked
 * from both ends by `scripts/check-norms.ts`; see D82.
 *
 *   handshake-deadline-closes-session
 *   no-bare-typeerror
 */
import { describe, expect, test } from 'bun:test'
import { Client } from './client.ts'
import { defineContract, type MapOf, type$ } from './contract.ts'
import { TransportError } from './errors.ts'
import { createServer } from './server.ts'
import { loopbackPair } from './transport/loopback.ts'
import type { BidiStream, CloseInfo, Connection } from './transport/types.ts'

const contract = defineContract({
  chat: { lane: 'stream', payload: type$<{ body: string }>() },
  save: { lane: 'stream', payload: type$<{ text: string }>(), returns: type$<{ n: number }>() },
  slow: { lane: 'stream', payload: type$<null>(), returns: type$<null>() },
})
interface AppMap extends MapOf<typeof contract> {}

async function wire() {
  const server = createServer<AppMap>({ contract })
  await server.listen()
  const [serverSide, clientSide] = loopbackPair()
  const client = new Client<AppMap>({ contract, connect: async () => clientSide })
  const [peer] = await Promise.all([server.accept(serverSide), client.connect()])
  return { server, client, peer }
}

describe('handle() can actually be revoked', () => {
  test('the disposer stops peers that were already connected', async () => {
    const { server, client } = await wire()
    const off = server.handle('save', async ({ text }) => ({ n: text.length }))
    expect(await client.call('save', { text: 'abc' })).toEqual({ n: 3 })

    off()

    // Was: the disposer deleted only from the server's own map, while the per-session
    // registrations it made at accept time stayed live. Revoking a privileged responder
    // did nothing at all for the peers that were connected when you revoked it.
    await expect(client.call('save', { text: 'abc' })).rejects.toThrow()
  })
})

describe('a room cannot be joined by a session that is already gone', () => {
  test('join() after teardown does not insert a dead peer', async () => {
    const { server, client, peer } = await wire()
    client.disconnect()
    await new Promise((r) => setTimeout(r, 30))

    // The canonical pattern is `onSession(async peer => { await lookup(); await peer.join(r) })`,
    // so a client dropping mid-lookup lands exactly here. Every such join used to succeed
    // and be retained for ever: the notify write died in the emit path's swallowing catch,
    // so nothing surfaced, and no later teardown ran to remove it.
    await peer.join('lobby').catch(() => undefined)
    expect(server.memberCount('lobby')).toBe(0)
  })

  test('fifty of them do not accumulate', async () => {
    const { server, client, peer } = await wire()
    client.disconnect()
    await new Promise((r) => setTimeout(r, 30))
    for (let i = 0; i < 50; i++) await peer.join('lobby').catch(() => undefined)
    expect(server.memberCount('lobby')).toBe(0)
  })
})

describe('the handshake deadline covers the whole handshake', () => {
  test('a transport that never opens the emit stream still times out', async () => {
    // The deadline was armed *after* `openEmitStream()` and after writing our own
    // handshake. If either never settled — the stalled-peer case the deadline exists for —
    // no timer was ever armed and connect() hung for ever.
    const conn: Connection = {
      closed: new Promise<CloseInfo>(() => {}),
      openEmitStream: () => new Promise<WritableStream<Uint8Array>>(() => {}), // never
      onEmitStream: () => {},
      openBidi: async () => ({}) as BidiStream,
      onBidi: () => {},
      sendDatagram: () => {},
      onDatagram: () => {},
      maxDatagramSize: () => 1024,
      reliability: () => 'supports-unreliable',
      close: () => {},
    }
    const client = new Client<AppMap>({
      contract,
      connect: async () => conn,
      handshakeDeadlineMs: 60,
    })

    const outcome = await Promise.race([
      client.connect().then(
        () => 'connected',
        (e: unknown) => (e as Error).message,
      ),
      new Promise<string>((r) => setTimeout(() => r('HUNG'), 800)),
    ])
    expect(outcome).toContain('WT_HANDSHAKE_TIMEOUT')
  })
})

describe('an aborted call rejects with this library’s own error', () => {
  test('the rejection is a TransportError with code WT_ABORTED', async () => {
    const { server, client } = await wire()
    server.handle('slow', () => new Promise<never>(() => {}))

    const err = await client.call('slow', null, { signal: AbortSignal.timeout(30) }).then(
      () => null,
      (e: unknown) => e,
    )

    // Was a raw DOMException — `name: 'TimeoutError'`, `code: 23`, no `remedy`. The error
    // helper printed verbatim in API.md returns 'unknown' for it, and `WT_ABORTED` is in
    // the exported code union while being constructed nowhere. Aborting a call is the most
    // documented failure path this library has.
    expect(err).toBeInstanceOf(TransportError)
    expect((err as TransportError).code).toBe('WT_ABORTED')
    expect((err as TransportError).remedy.length).toBeGreaterThan(0)
  })
})
