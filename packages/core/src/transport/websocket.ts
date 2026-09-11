/**
 * `transport-io/websocket-transport`: the fallback connector, for `withFallback`.
 *
 * This is the whole entry. The connection it returns, the socket interface, the close-code
 * mapping and the sink's low-water mark live in `websocket-connection.ts` and are not
 * exported from the package, as the transport seam is not (D21, D127).
 */
import { TransportError } from '../errors.ts'
import type { Connection } from './types.ts'
import { type SocketLike, WebSocketConnection } from './websocket-connection.ts'

export interface WebSocketConnectOptions {
  /** `ws://` or `wss://`. A `wss://` origin needs a certificate the platform trusts. */
  readonly url: string
}

/**
 * The fallback connector, for `withFallback`. Runtime-neutral: it reads the global
 * `WebSocket`, which browsers, Node and Bun all provide.
 */
export async function connectWebSocket(opts: WebSocketConnectOptions): Promise<Connection> {
  const WS = (globalThis as { WebSocket?: new (url: string) => SocketLike }).WebSocket
  if (WS === undefined) {
    throw new TransportError(
      'WT_NO_SUPPORT',
      'this runtime has no WebSocket',
      'Use a browser, Node 22 or later, or Bun.',
    )
  }
  const socket = new WS(opts.url)
  socket.binaryType = 'arraybuffer'
  await new Promise<void>((resolve, reject) => {
    socket.addEventListener('open', () => resolve())
    socket.addEventListener('close', (ev) => {
      reject(
        new TransportError(
          'WT_HANDSHAKE_FAILED',
          `the WebSocket handshake to ${opts.url} failed, close code ${ev.code}`,
          'Check that the server is running, that its WebSocket listener is reachable over TCP, and that a wss:// certificate is one this platform trusts.',
        ),
      )
    })
    socket.addEventListener('error', () => {
      // The close event that follows carries the code; rejecting here would report twice.
    })
  })
  return new WebSocketConnection(socket)
}
