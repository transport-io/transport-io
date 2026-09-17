/**
 * The parity suite against the fails-components transport. One transport per process - see
 * `parity-suite.ts` for why. Run with `PARITY_PEER` set, this file is the peer the abrupt
 * case kills, and registers no tests.
 */
import { test } from 'node:test'
import { connectHttp3, listenHttp3 } from './transport/fails.node.ts'
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

const listen: UnderTest['listen'] = (o) => listenHttp3({ ...o, path: '/' })

const role = peerRole()
if (role === 'server') {
  await servePeer(listen)
} else if (role === 'client') {
  await connectPeer(connectHttp3)
} else {
  test('fails-components: both lanes, a call, an abort and an oversized datagram', {
    timeout: 60_000,
  }, async () => {
    await runParity({
      name: 'fails-components',
      port: randomPort(),
      listen,
      lanes: 'all',
      propagatesAbortToHandler: true,
      connect: connectHttp3,
    })
  })

  test('fails-components: a peer killed with no close handshake is noticed', {
    timeout: 90_000,
  }, async () => {
    await runAbruptDrop({
      name: 'fails-components',
      // QUIC learns it from the idle timeout, measured at 21 s on this binding.
      noticeWithinMs: 45_000,
      peer: () => spawnPeer(import.meta.filename, connectHttp3),
    })
  })

  test('fails-components: a quiet server notices a client killed with no close handshake', {
    timeout: 90_000,
  }, async () => {
    await runAbruptClientDrop({
      name: 'fails-components',
      // The liveness probe's interval, then the stack giving up on what it sent: 15 s and
      // about 8 s, measured. Without the probe this never settled, watched for 240 s.
      noticeWithinMs: 45_000,
      testFile: import.meta.filename,
      listen,
    })
  })
}
