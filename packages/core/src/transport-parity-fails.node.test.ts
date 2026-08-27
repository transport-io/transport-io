/**
 * The parity suite against the fails-components transport. One transport per process - see
 * `parity-suite.ts` for why.
 */
import { test } from 'node:test'
import { connectHttp3, listenHttp3 } from './transport/fails.node.ts'
import { randomPort, runParity } from './transport/parity-suite.ts'

test('fails-components: both lanes, a call, an abort and an oversized datagram', {
  timeout: 60_000,
}, async () => {
  await runParity({
    name: 'fails-components',
    port: randomPort(),
    listen: (o) => listenHttp3({ ...o, path: '/' }),
    propagatesAbortToHandler: true,
    connect: connectHttp3,
  })
})
