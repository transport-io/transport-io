/**
 * The parity suite against the WebSocket mapping. Plain `ws://`: the suite mints a
 * self-signed certificate that Node's WebSocket would refuse, and the mapping under test is
 * the same either way. TLS is the platform's, not this transport's.
 */
import { test } from 'node:test'
import { randomPort, runParity } from './transport/parity-suite.ts'
import { listenWebSocket } from './transport/websocket.node.ts'
import { connectWebSocket } from './transport/websocket.ts'

test('websocket: the reliable lane, a declared unreliable event, and a refused call', {
  timeout: 60_000,
}, async () => {
  await runParity({
    name: 'websocket',
    port: randomPort(),
    lanes: 'reliable-only',
    propagatesAbortToHandler: false,
    listen: (o) => listenWebSocket({ port: o.port, host: o.host, path: '/' }),
    connect: (o) => connectWebSocket({ url: o.url.replace(/^https:/, 'ws:') }),
  })
})
