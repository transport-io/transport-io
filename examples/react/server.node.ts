/** The server. Started by `transport-io dev`, which mints the certificate. Node only. */
import { createServer, type ServerPeer } from 'transport-io'
import { listenDev } from 'transport-io/node-transport'
import { type ChatMap, contract } from './contract.ts'

const ROOM = 'lobby'
const server = createServer<ChatMap>({ contract })
// Keyed by the peer, so the entry goes when the session does.
const loss = new WeakMap<ServerPeer<ChatMap>, number>()

function clampPercent(n: number) {
  return Number.isFinite(n) ? Math.min(100, Math.max(0, Math.round(n))) : 0
}

server.handle('setName', async ({ name }) => {
  const trimmed = name.trim().slice(0, 24)
  return trimmed.length === 0
    ? { accepted: false, name: '' }
    : { accepted: true, name: trimmed }
})

// Answers with the clamped value, which is what the page shows.
server.handle('setLoss', async ({ percent }, ctx) => {
  const p = clampPercent(percent)
  loss.set(ctx.peer, p / 100)
  return { percent: p }
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
    // Drops the caller's chosen share before broadcasting.
    const p = loss.get(peer) ?? 0
    if (p > 0 && Math.random() < p) return
    void server.to(ROOM).except(peer.id).emit('cursor', pos)
  })
})

await server.listen(await listenDev())
console.log('chat server ready')
