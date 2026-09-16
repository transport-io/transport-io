/**
 * The WebSocket listener. PROTOCOL.md §3.3.
 *
 * Node has no WebSocket server of its own, so this one is `ws`, a dependency of the package:
 * a few hundred kilobytes of JavaScript beside a native QUIC binding that is already
 * required, so nothing is gained by making it optional (D122). The HTTP server underneath it
 * is also the probe target from D120: any request gets an answer, so a client that reaches
 * this port over TCP and not the QUIC port over UDP learns which it is.
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
import { WebSocketServer } from 'ws'
import { CloseCode } from '../protocol.ts'
import { asPortInUse } from './port.node.ts'
import { PROBE_PATH } from './probe.ts'
import type { Authorize, Connection, ConnectRequest } from './types.ts'
import {
  type SocketLike,
  toWebSocketCloseCode,
  WebSocketConnection,
} from './websocket-connection.ts'

export interface WebSocketServerOptions<D = undefined> {
  readonly port: number
  readonly host?: string
  /** PEM. Both or neither: with them the listener is `wss://`, without them `ws://`. */
  readonly cert?: string
  readonly privKey?: string
  readonly path?: string
  /**
   * Decides each peer from its upgrade request, which carries headers and cookies as well
   * as the path and query. What it returns is `peer.data`; `null` closes the socket as
   * `WT_UNAUTHORIZED` before the handshake.
   */
  readonly authorize?: Authorize<D>
}

export interface WebSocketListener<D = undefined> {
  readonly port: number
  sessions(): AsyncIterable<Connection & { readonly data?: D }>
  stop(): void
}

function requestOf(req: IncomingMessage): ConnectRequest {
  const raw = req.url ?? '/'
  const at = raw.indexOf('?')
  const headers: Record<string, string> = {}
  for (const [k, v] of Object.entries(req.headers)) {
    if (typeof v === 'string') headers[k] = v
    else if (Array.isArray(v)) headers[k] = v.join(', ')
  }
  return {
    path: at === -1 ? raw : raw.slice(0, at),
    query: new URLSearchParams(at === -1 ? '' : raw.slice(at + 1)),
    peerAddress: req.socket.remoteAddress ?? '',
    headers,
  }
}

function answer(req: IncomingMessage, res: ServerResponse): void {
  // Any status is an answer to the probe. 204 at its path, 404 elsewhere, and nothing else
  // is served: this is a transport listener, not a web server.
  res.writeHead(req.url === PROBE_PATH ? 204 : 404).end()
}

export async function listenWebSocket<D = undefined>(
  opts: WebSocketServerOptions<D>,
): Promise<WebSocketListener<D>> {
  const http =
    opts.cert !== undefined && opts.privKey !== undefined
      ? createHttpsServer({ cert: opts.cert, key: opts.privKey }, answer)
      : createHttpServer(answer)
  const wss = new WebSocketServer({ server: http, path: opts.path ?? '/' })

  type Accepted = Connection & { readonly data?: D }
  const queue: Accepted[] = []
  let waiting: ((next: Accepted | undefined) => void) | undefined
  let stopped = false
  const deliver = (conn: Accepted): void => {
    if (waiting !== undefined) {
      const wake = waiting
      waiting = undefined
      wake(conn)
    } else {
      queue.push(conn)
    }
  }
  const refuse = (socket: SocketLike, reason: string): void => {
    socket.close(toWebSocketCloseCode(CloseCode.WT_UNAUTHORIZED), reason)
  }
  const authorize = opts.authorize
  wss.on('connection', (raw, req) => {
    const socket = raw as unknown as SocketLike
    if (authorize === undefined) {
      deliver(new WebSocketConnection(socket) as Accepted)
      return
    }
    void (async () => {
      let verdict: D | null
      try {
        verdict = await authorize(requestOf(req))
      } catch {
        refuse(socket, 'authorize failed')
        return
      }
      if (verdict === null) {
        refuse(socket, 'refused by authorize')
        return
      }
      deliver(new WebSocketConnection(socket, { data: verdict }) as Accepted)
    })()
  })

  await new Promise<void>((resolve, reject) => {
    http.once('error', (e) => reject(asPortInUse(e, `TCP port ${opts.port}`)))
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
    async *sessions(): AsyncIterable<Accepted> {
      for (;;) {
        if (stopped) return
        const next =
          queue.shift() ??
          (await new Promise<Accepted | undefined>((resolve) => {
            waiting = resolve
          }))
        if (next === undefined) return
        yield next
      }
    },
  }
}
