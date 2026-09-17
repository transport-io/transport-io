/**
 * The abrupt case against the loopback. It has no process to kill, so the pair can lose its
 * connection instead (`drop()`), with the platform-shaped `closed` underneath rejecting as
 * the WebTransport specification says a session's does. What this holds to account is the
 * mapping every adapter shares and everything above the seam: the session releasing, the
 * client leaving `connected`, the server forgetting the peer.
 */
import { expect, test } from 'bun:test'
import { Client } from './client.ts'
import { defineContract, type MapOf, rpc } from './contract.ts'
import { createServer } from './server.ts'
import { loopbackPair } from './transport/loopback.ts'
import { localPeer, runAbruptDrop } from './transport/parity-suite.ts'

// norm: lost-connection-ends-session
test('loopback: a peer killed with no close handshake is noticed', async () => {
  const peer = await localPeer()
  await runAbruptDrop({
    name: 'loopback',
    noticeWithinMs: 1_000,
    peer: async () => {
      const [serverSide, clientSide, link] = loopbackPair()
      return {
        connect: async () => {
          peer.accept(serverSide)
          return clientSide
        },
        kill: () => link.drop(),
      }
    },
  })
  // The survivor in the other direction: the server let go of the peer it lost.
  expect(peer.members()).toBe(0)
})

const contract = defineContract({ slow: rpc<null, null>() })
interface AppMap extends MapOf<typeof contract> {}

test('loopback: a lost connection releases a call in flight, and a reconnect follows it', async () => {
  const server = createServer<AppMap>({ contract })
  await server.listen()
  server.handle('slow', async () => {
    await new Promise((resolve) => setTimeout(resolve, 5_000))
    return null
  })
  const links: Array<{ drop: () => void }> = []
  const client = new Client<AppMap>({
    contract,
    reconnect: { minMs: 5, maxMs: 10 },
    connect: async () => {
      const [serverSide, clientSide, link] = loopbackPair()
      links.push(link)
      void server.accept(serverSide).catch(() => undefined)
      return clientSide
    },
  })
  await client.connect()
  const pending = client.call('slow', null)
  await new Promise((resolve) => setTimeout(resolve, 20))
  links[0]?.drop()
  await expect(pending).rejects.toBeDefined()
  await new Promise((resolve) => setTimeout(resolve, 80))
  expect(client.getSnapshot().status).toBe('connected')
  expect(links).toHaveLength(2)
  client.disconnect()
})
