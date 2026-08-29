/** The fixture's server. Started by `transport-io dev`, so the certificate is handled. */
import { createServer } from 'transport-io'
import { listenDev } from 'transport-io/node-transport'
import { contract, type E2EMap } from './contract.ts'

const ROOM = 'e2e'
const server = createServer<E2EMap>({ contract })

let broadcasts = 0
let sessions = 0

// The fixture reports its own counters, so a duplicate can be traced to the side that
// caused it rather than guessed at.
server.handle('save', async ({ text }) =>
  text === '__stats'
    ? { n: sessions * 1000 + broadcasts * 10 + server.memberCount(ROOM) }
    : { n: text.length },
)

server.handle('ask', async function* ({ prompt }) {
  for (const word of prompt.split(' ')) {
    yield word
    await new Promise((r) => setTimeout(r, 30))
  }
})

server.onSession((peer) => {
  sessions++
  void peer.join(ROOM)
  peer.on('chat', (msg) => {
    broadcasts++
    void server.to(ROOM).emit('chat', msg)
  })
})

await server.listen(await listenDev())
console.log('react e2e fixture server ready')
