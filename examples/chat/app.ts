/** The handlers, shared by server.node.ts and deploy/server.node.ts. */
import type { Server, ServerPeer } from 'transport-io'
import { AGENTS, paceOf } from './agents.ts'
import type { ChatMap } from './contract.ts'

export interface AttachOptions {
  /** Concurrent `generate` streams one session may hold. Unlimited when absent. */
  readonly maxGenerationsPerPeer?: number
  readonly room?: string
  readonly log?: (line: string) => void
}

const clampPercent = (n: number): number =>
  Number.isFinite(n) ? Math.min(100, Math.max(0, Math.round(n))) : 0

export function attach(server: Server<ChatMap>, opts: AttachOptions = {}): void {
  const room = opts.room ?? 'lobby'
  const log = opts.log ?? console.log
  const maxGenerations = opts.maxGenerationsPerPeer ?? Number.POSITIVE_INFINITY

  const names = new Map<string, string>()
  // Keyed by the peer, so the entry goes when the session does.
  const loss = new WeakMap<ServerPeer<ChatMap>, number>()
  const generating = new WeakMap<ServerPeer<ChatMap>, number>()

  server.handle('setName', async ({ name }) => {
    const trimmed = name.trim().slice(0, 24)
    if (trimmed.length === 0) return { accepted: false, name: '' }
    return { accepted: true, name: trimmed }
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

  server.handle('generate', async function* ({ agent }, ctx) {
    const script = AGENTS[agent]
    if (script === undefined) throw new Error(`unknown agent '${agent}'`)
    const active = generating.get(ctx.peer) ?? 0
    if (active >= maxGenerations) {
      throw new Error(`at most ${maxGenerations} generations at once on one session`)
    }
    generating.set(ctx.peer, active + 1)
    let sent = 0
    try {
      for (const [i, token] of script.tokens.entries()) {
        await new Promise((r) => setTimeout(r, paceOf(script, i)))
        yield token
        sent++
      }
      log(`generate ${agent}: done, ${sent} tokens`)
    } finally {
      generating.set(ctx.peer, (generating.get(ctx.peer) ?? 1) - 1)
      if (ctx.signal.aborted) log(`generate ${agent}: cancelled after ${sent} tokens`)
    }
  })

  server.onSession((peer) => {
    void peer.join(room)
    names.set(peer.id, `guest-${peer.origin.toString(16).slice(-4)}`)
    log(`+ ${peer.id} joined (${names.size} online)`)

    peer.on('chat', (msg) => {
      // To everyone, the sender included.
      void server.to(room).emit('chat', { ...msg, at: Date.now() })
    })

    peer.on('cursor', (pos) => {
      // Drops the caller's chosen share before broadcasting.
      const p = loss.get(peer) ?? 0
      if (p > 0 && Math.random() < p) return
      void server.to(room).except(peer.id).emit('cursor', pos)
    })
  })
}
