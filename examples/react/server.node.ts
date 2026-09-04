/** The server. Started by `transport-io dev`, which mints the certificate. Node only. */
import { createServer } from 'transport-io'
import { listenDev } from 'transport-io/node-transport'
import { type ChatMap, contract } from './contract.ts'

const ROOM = 'lobby'
const server = createServer<ChatMap>({ contract })

server.handle('setName', async ({ name }) => {
  const trimmed = name.trim().slice(0, 24)
  return trimmed.length === 0
    ? { accepted: false, name: '' }
    : { accepted: true, name: trimmed }
})

server.handle('say', async function* ({ text }) {
  for (const word of text.split(/\s+/).filter(Boolean)) {
    await new Promise((r) => setTimeout(r, 80))
    yield word
  }
})

server.onSession((peer) => {
  void peer.join(ROOM)
  peer.on('chat', (msg) => {
    // To everyone, the sender included.
    void server.to(ROOM).emit('chat', { ...msg, at: Date.now() })
  })
  peer.on('cursor', (pos) => {
    void server.to(ROOM).except(peer.id).emit('cursor', pos)
  })
})

await server.listen(await listenDev())
console.log('chat server ready')
