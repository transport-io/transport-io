/**
 * The application, registered on a server.
 *
 * `server.node.ts` wires a listener and a static file server around this. Keeping the
 * handlers here rather than in that file means anything else that serves this contract
 * registers the same ones, and the e2e suite that drives the local server is exercising them.
 */
import type { Server, ServerPeer } from 'transport-io'
import { AGENTS, paceOf } from './agents.ts'
import type { ChatMap } from './contract.ts'

export interface AttachOptions {
  readonly room?: string
  readonly log?: (line: string) => void
}

const clampPercent = (n: number): number =>
  Number.isFinite(n) ? Math.min(100, Math.max(0, Math.round(n))) : 0

export function attach(server: Server<ChatMap>, opts: AttachOptions = {}): void {
  const room = opts.room ?? 'lobby'
  const log = opts.log ?? console.log

  const names = new Map<string, string>()
  // Keyed by the peer object rather than its id, so nothing has to be cleaned up when a
  // session ends: there is no close hook on a peer, and a map keyed by id would grow for the
  // life of the process.
  const loss = new WeakMap<ServerPeer<ChatMap>, number>()

  // Callable: the client asks for a name and gets an answer back on the same stream.
  server.handle('setName', async ({ name }) => {
    const trimmed = name.trim().slice(0, 24)
    if (trimmed.length === 0) return { accepted: false, name: '' }
    return { accepted: true, name: trimmed }
  })

  // The packet-loss toggle. It answers with what it actually set, and the page shows that.
  server.handle('setLoss', async ({ percent }, ctx) => {
    const p = clampPercent(percent)
    loss.set(ctx.peer, p / 100)
    return { percent: p }
  })

  // Streaming: one word at a time, on the same kind of stream a call uses. `break` on the
  // client resets it, which fires `ctx.signal` here, which ends the loop below.
  server.handle('say', async function* ({ text }) {
    for (const word of text.split(/\s+/).filter(Boolean)) {
      await new Promise((r) => setTimeout(r, 80))
      yield word
    }
  })

  // Two of these run at once on `/agents.html`, each on its own bidirectional stream.
  //
  // The `finally` is the half worth reading. Stopping a panel resets that stream, which
  // fires `ctx.signal` and returns this generator, so the server stops producing rather than
  // producing into a reader that has gone away. Watch this log line while you click stop: it
  // is the server-side half of what the page's counters show.
  server.handle('generate', async function* ({ agent }, ctx) {
    const script = AGENTS[agent]
    if (script === undefined) throw new Error(`unknown agent '${agent}'`)
    let sent = 0
    try {
      for (const [i, token] of script.tokens.entries()) {
        await new Promise((r) => setTimeout(r, paceOf(script, i)))
        yield token
        sent++
      }
      log(`generate ${agent}: done, ${sent} tokens`)
    } finally {
      if (ctx.signal.aborted) log(`generate ${agent}: cancelled after ${sent} tokens`)
    }
  })

  server.onSession((peer) => {
    void peer.join(room)
    names.set(peer.id, `guest-${peer.origin.toString(16).slice(-4)}`)
    log(`+ ${peer.id} joined (${names.size} online)`)

    peer.on('chat', (msg) => {
      // Reliable lane: everyone gets it, including the sender, so their own message appears
      // in the same order everyone else sees it.
      void server.to(room).emit('chat', { ...msg, at: Date.now() })
    })

    peer.on('cursor', (pos) => {
      // The toggle: drop this share of the sender's frames before they go anywhere. A frame
      // the network would have lost and a frame dropped here are the same frame to every
      // other window, which is what makes a server-side simulation an honest one.
      const p = loss.get(peer) ?? 0
      if (p > 0 && Math.random() < p) return
      // Unreliable lane: excluded from the sender, because you already know where your own
      // pointer is, and a dropped one is simply the next frame's problem.
      void server.to(room).except(peer.id).emit('cursor', pos)
    })
  })
}
