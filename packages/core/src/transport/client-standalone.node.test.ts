/**
 * A Node client in a process that contains no server.
 *
 * This is the exact shape that was invisible. The binding loads its native transport
 * through a dynamic import and throws `Lib quiche loading attempt did not end` if a client
 * is constructed before that settles. A process that also runs a server never sees it,
 * because the server awaits the same promise on its way up — so every test we had passed
 * while a standalone Node client would have thrown every time.
 *
 * `node --test` runs each file in its own process, so nothing here may construct a server.
 * If someone adds one to this file, the test silently stops testing anything.
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { connectHttp3 } from './fails.node.ts'

test('connecting from a server-less process gets past native loading', async () => {
  // Port chosen to be closed. The connection must fail — but it must fail because nothing
  // is listening, not because the native transport had not finished loading.
  const err = await connectHttp3({
    url: 'https://127.0.0.1:34599/',
    certificateHash: new Uint8Array(32),
  }).then(
    () => null,
    (e: unknown) => e,
  )

  assert.notEqual(err, null, 'expected the connection to fail against a closed port')
  const message = err instanceof Error ? err.message : String(err)

  assert.doesNotMatch(
    message,
    /quiche loading attempt did not end/i,
    'the native transport was not awaited before constructing the client — see the ' +
      '`await quicheLoaded` in connectHttp3',
  )

  // A failed connect must also be a typed error rather than whatever the binding threw,
  // and must not leave `closed` rejecting with nobody attached: an unhandled rejection
  // terminates a Node server by default.
  assert.match(message, /WT_SESSION_CLOSED/)
})

test('the native transport is actually loaded, not merely not-thrown', async () => {
  // Distinguishes "we awaited it" from "we caught the error". The binding only exposes a
  // working WebTransport once the dynamic import resolves.
  const { quicheLoaded, WebTransport } = await import('@fails-components/webtransport')
  await quicheLoaded
  assert.equal(typeof WebTransport, 'function')
})
