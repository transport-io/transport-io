/**
 * The probe against a real TCP listener and a real QUIC client.
 *
 * Nothing is stubbed: the native client dials a port with no QUIC server behind it, and a
 * plain HTTP server on the same port number is what answers the probe. Plain HTTP because
 * Node's `fetch` rejects a self-signed certificate, which is exactly what keeps the probe
 * from ever claiming a blocked path through a certificate it should not trust.
 */
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { test } from 'node:test'
import type { TransportError } from '../errors.ts'
import { connectHttp3 } from './fails.node.ts'
import { PROBE_PATH } from './probe.ts'

const failure = (p: Promise<unknown>): Promise<TransportError> =>
  p.then(
    () => assert.fail('expected the handshake to fail'),
    (e: unknown) => e as TransportError,
  )

test('a port that answers over TCP but not over QUIC is WT_UDP_UNREACHABLE', async () => {
  const seen: string[] = []
  const http = createServer((req, res) => {
    seen.push(`${req.method} ${req.url}`)
    res.writeHead(404).end()
  })
  await new Promise<void>((resolve) => http.listen(0, '127.0.0.1', resolve))
  const address = http.address()
  assert.ok(address !== null && typeof address === 'object')
  const port = address.port

  try {
    const err = await failure(
      connectHttp3({
        url: `https://127.0.0.1:${port}/`,
        certificateHash: new Uint8Array(32),
        probe: `http://127.0.0.1:${port}${PROBE_PATH}`,
      }),
    )
    assert.equal(err.code, 'WT_UDP_UNREACHABLE')
    assert.deepEqual(seen, [`HEAD ${PROBE_PATH}`])
    assert.match(err.remedy, /UDP/)
  } finally {
    http.close()
  }
})

test('a port that answers nothing keeps WT_HANDSHAKE_FAILED and says the origin was silent', async () => {
  // Chosen to be closed on both TCP and UDP.
  const err = await failure(
    connectHttp3({ url: 'https://127.0.0.1:34598/', certificateHash: new Uint8Array(32) }),
  )
  assert.equal(err.code, 'WT_HANDSHAKE_FAILED')
  assert.match(err.message, /did not answer over HTTPS/)
})
