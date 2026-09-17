/** The fixture's server. Started by `transport-io dev`, so the certificate is handled. */
import { createServer, refuse, type ServerPeer } from 'transport-io'
import { listenDev } from 'transport-io/node-transport'
import { contract, type E2EMap } from './contract.ts'

const ROOM = 'e2e'
const server = createServer<E2EMap>({ contract })

// The door, for the sign-in page. A request with no token is the other page and is let in;
// a token has to be the valid one, and `__expire` below changes which one that is.
let validToken = 'good'
const peers = new Set<ServerPeer<E2EMap>>()

let broadcasts = 0
let sessions = 0

// The fixture reports its own counters, so a duplicate can be traced to the side that
// caused it rather than guessed at.
server.handle('save', async ({ text }) => {
  if (text === '__expire') {
    // Every token issued so far stops being valid and every session drops, which is a
    // token expiring under a page that is open: its reconnect is refused.
    validToken = 'fresh'
    for (const peer of peers) peer.close(0, 'expired')
    return { n: peers.size }
  }
  return text === '__stats'
    ? { n: sessions * 1000 + broadcasts * 10 + server.memberCount(ROOM) }
    : { n: text.length }
})

server.handle('ask', async function* ({ prompt }) {
  for (const word of prompt.split(' ')) {
    yield word
    await new Promise((r) => setTimeout(r, 30))
  }
})

server.onSession((peer) => {
  sessions++
  peers.add(peer)
  void peer.closed.then(() => peers.delete(peer))
  void peer.join(ROOM)
  peer.on('chat', (msg) => {
    broadcasts++
    void server.to(ROOM).emit('chat', msg)
  })
})

await server.listen(
  await listenDev({
    authorize: ({ query }) => {
      const token = query.get('token')
      return token === null || token === validToken ? undefined : refuse('expired')
    },
  }),
)
console.log('react e2e fixture server ready')
