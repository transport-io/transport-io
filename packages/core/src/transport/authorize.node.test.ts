/**
 * `authorize` on the real listeners. Over QUIC the request callback has to strip the query
 * from `:path` before the binding routes the session, or `/?token=x` never reaches a listener
 * on `/`: the first test dials with a query and is the one that failed before the callback
 * existed. A refused peer sees `WT_UNAUTHORIZED` and the server's `onSession` never runs.
 */
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { ensureCertificate } from '../cli/certificate.node.ts'
import { Client } from '../client.ts'
import { defineContract, type MapOf, reliable } from '../contract.ts'
import type { TransportError } from '../errors.ts'
import { createServer } from '../server.ts'
import { connectHttp3, listenHttp3 } from './fails.node.ts'
import { listenWebSocket } from './websocket.node.ts'
import { connectWebSocket } from './websocket.ts'

const contract = defineContract({ chat: reliable<{ body: string }>() })
interface AppMap extends MapOf<typeof contract> {}
interface Who {
  user: string
  from: string
}

const rejected = (p: Promise<unknown>): Promise<TransportError> =>
  p.then(
    () => {
      throw new Error('expected a rejection')
    },
    (e: unknown) => e as TransportError,
  )

test('over QUIC: a token in the query reaches authorize, becomes peer.data, and a bad one is refused', async () => {
  const cert = ensureCertificate(mkdtempSync(join(tmpdir(), 'tio-authorize-')))
  const listener = await listenHttp3({
    port: 0,
    host: '127.0.0.1',
    cert: cert.cert,
    privKey: cert.privKey,
    path: '/',
    authorize: ({ path, query, peerAddress }): Who | null => {
      assert.equal(path, '/')
      return query.get('token') === 'good' ? { user: 'ann', from: peerAddress } : null
    },
  })
  const server = createServer<AppMap, Who>({ contract })
  const seen: Who[] = []
  server.onSession((peer) => seen.push(peer.data))
  await server.listen(listener)
  const hash = Uint8Array.from(cert.sha256)
  try {
    const good = new Client<AppMap>({
      contract,
      connect: () =>
        connectHttp3({
          url: `https://127.0.0.1:${listener.port}/?token=good`,
          certificateHash: hash,
          probe: false,
        }),
    })
    await good.connect()
    good.disconnect()

    const bad = new Client<AppMap>({
      contract,
      connect: () =>
        connectHttp3({
          url: `https://127.0.0.1:${listener.port}/?token=bad`,
          certificateHash: hash,
          probe: false,
        }),
    })
    const err = await rejected(bad.connect())
    assert.equal(err.code, 'WT_UNAUTHORIZED')
    assert.match(err.message, /refused by authorize/)

    assert.equal(seen.length, 1)
    assert.equal(seen[0]?.user, 'ann')
    assert.match(seen[0]?.from ?? '', /127\.0\.0\.1/)
  } finally {
    listener.stop()
  }
})

test('over the WebSocket: the upgrade request reaches authorize, headers included', async () => {
  const listener = await listenWebSocket({
    port: 0,
    authorize: ({ query, headers }): Who | null =>
      query.get('token') === 'good' ? { user: 'bob', from: headers.host ?? '' } : null,
  })
  const server = createServer<AppMap, Who>({ contract })
  const seen: Who[] = []
  server.onSession((peer) => seen.push(peer.data))
  await server.listen()
  server.withFallback(listener)
  try {
    const good = new Client<AppMap>({
      contract,
      connect: () => connectWebSocket({ url: `ws://127.0.0.1:${listener.port}/?token=good` }),
    })
    await good.connect()
    good.disconnect()

    const bad = new Client<AppMap>({
      contract,
      connect: () => connectWebSocket({ url: `ws://127.0.0.1:${listener.port}/?token=bad` }),
    })
    const err = await rejected(bad.connect())
    assert.equal(err.code, 'WT_UNAUTHORIZED')

    assert.equal(seen.length, 1)
    assert.equal(seen[0]?.user, 'bob')
    assert.match(seen[0]?.from ?? '', /127\.0\.0\.1/)
  } finally {
    listener.stop()
  }
})
