/**
 * The parity suite against the WebSocket mapping. Plain `ws://`: the suite mints a
 * self-signed certificate that Node's WebSocket would refuse, and the mapping under test is
 * the same either way. TLS is the platform's, not this transport's. Run with `PARITY_PEER`
 * set, this file is the peer the abrupt case kills, and registers no tests.
 */
import { test } from 'node:test'
import {
  connectPeer,
  peerRole,
  randomPort,
  runAbruptClientDrop,
  runAbruptDrop,
  runParity,
  servePeer,
  spawnPeer,
  type UnderTest,
} from './transport/parity-suite.ts'
import { listenWebSocket } from './transport/websocket.node.ts'
import { connectWebSocket } from './transport/websocket.ts'

const listen: UnderTest['listen'] = (o) =>
  listenWebSocket({ port: o.port, host: o.host, path: '/' })
const connect: UnderTest['connect'] = (o) =>
  connectWebSocket({ url: o.url.replace(/^https:/, 'ws:') })

const role = peerRole()
if (role === 'server') {
  await servePeer(listen)
} else if (role === 'client') {
  await connectPeer(connect)
} else {
  test('websocket: the reliable lane, a declared unreliable event, and a refused call', {
    timeout: 60_000,
  }, async () => {
    await runParity({
      name: 'websocket',
      port: randomPort(),
      lanes: 'reliable-only',
      propagatesAbortToHandler: false,
      listen,
      connect,
    })
  })

  test('websocket: a peer killed with no close handshake is noticed', {
    timeout: 30_000,
  }, async () => {
    await runAbruptDrop({
      name: 'websocket',
      // The kernel closes a killed process's socket, so the survivor hears at once.
      noticeWithinMs: 5_000,
      peer: () => spawnPeer(import.meta.filename, connect),
    })
  })

  test('websocket: a quiet server notices a client killed with no close handshake', {
    timeout: 30_000,
  }, async () => {
    await runAbruptClientDrop({
      name: 'websocket',
      noticeWithinMs: 5_000,
      testFile: import.meta.filename,
      listen,
    })
  })
}
