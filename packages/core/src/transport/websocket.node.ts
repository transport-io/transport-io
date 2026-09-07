/**
 * The WebSocket listener. PROTOCOL.md §3.3.
 *
 * Node has no WebSocket server of its own, so this one is `ws`, loaded by dynamic import
 * exactly as the QUIC transport is: an optional peer, installed only where a fallback
 * listener runs, and reported plainly when it is absent. The HTTP server underneath it is
 * also the probe target from D120: any request gets an answer, so a client that reaches this
 * port over TCP and not the QUIC port over UDP learns which it is.
 *
 * `cert` and `privKey` make it `wss://`, on the certificate the site already serves. Without
 * them it is `ws://`, which is what development on loopback uses, since a browser pins no
 * hash for a WebSocket and would refuse the minted certificate.
 */
import {
  createServer as createHttpServer,
  type IncomingMessage,
  type ServerResponse,
} from 'node:http'
import { createServer as createHttpsServer } from 'node:https'
import { TransportError } from '../errors.ts'
import { PROBE_PATH } from './probe.ts'
import type { Connection } from './types.ts'
import { type SocketLike, WebSocketConnection } from './websocket.ts'

export interface WebSocketServerOptions {
  readonly port: number
  readonly host?: string
  /** PEM. Both or neither: with them the listener is `wss://`, without them `ws://`. */
  readonly cert?: string
  readonly privKey?: string
  readonly path?: string
}

export interface WebSocketListener {
  readonly port: number
  sessions(): AsyncIterable<Connection>
  stop(): void
}

async function loadWs(): Promise<typeof import('ws')> {
  try {
    return await import('ws')
  } catch (cause) {
    throw new TransportError(
      'WT_NO_SUPPORT',
      'the WebSocket listener needs the ws package, and it is not installed',
      'Run `npm install ws`. It is an optional peer of transport-io, needed only by a process that listens for the fallback.',
      cause,
    )
  }
}

function answer(req: IncomingMessage, res: ServerResponse): void {
  // Any status is an answer to the probe. 204 at its path, 404 elsewhere, and nothing else
  // is served: this is a transport listener, not a web server.
  res.writeHead(req.url === PROBE_PATH ? 204 : 404).end()
}

export async function listenWebSocket(
  opts: WebSocketServerOptions,
): Promise<WebSocketListener> {
  const ws = await loadWs()
  const http =
    opts.cert !== undefined && opts.privKey !== undefined
      ? createHttpsServer({ cert: opts.cert, key: opts.privKey }, answer)
      : createHttpServer(answer)
  const wss = new ws.WebSocketServer({ server: http, path: opts.path ?? '/' })

  const queue: Connection[] = []
  let waiting: ((next: Connection | undefined) => void) | undefined
  let stopped = false
  wss.on('connection', (socket) => {
    const conn = new WebSocketConnection(socket as unknown as SocketLike)
    if (waiting !== undefined) {
      const wake = waiting
      waiting = undefined
      wake(conn)
    } else {
      queue.push(conn)
    }
  })

  await new Promise<void>((resolve, reject) => {
    http.once('error', reject)
    http.listen(opts.port, opts.host ?? '127.0.0.1', resolve)
  })
  const address = http.address()

  return {
    port: address !== null && typeof address === 'object' ? address.port : opts.port,
    stop: () => {
      stopped = true
      waiting?.(undefined)
      for (const client of wss.clients) client.terminate()
      wss.close()
      // Keep-alive connections from probes would otherwise hold the server open for their
      // idle timeout, which is seconds, after everything it served is gone.
      http.closeAllConnections()
      http.close()
    },
    async *sessions(): AsyncIterable<Connection> {
      for (;;) {
        if (stopped) return
        const next =
          queue.shift() ??
          (await new Promise<Connection | undefined>((resolve) => {
            waiting = resolve
          }))
        if (next === undefined) return
        yield next
      }
    },
  }
}
