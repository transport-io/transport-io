/**
 * A port that is already held fails loudly, before anything binds.
 *
 * Two silences this closes. The QUIC binding binds a UDP port another process already holds
 * and reports nothing: the second server starts, prints its URL, and never receives a
 * session. And the dev command binds `127.0.0.1:<port>` while another server holds the same
 * port on `::`, which is legal to the kernel and wrong to a browser: `localhost` may resolve
 * to `::1`, which is the other server. So a UDP port is probed with a plain bind, and a TCP
 * port is probed on both loopback addresses by connecting to it, and either being held is
 * `WT_PORT_IN_USE` with the address that answered.
 */
import { createSocket } from 'node:dgram'
import { connect } from 'node:net'
import { TransportError } from '../errors.ts'

const CONNECT_BUDGET_MS = 300

function held(what: string): TransportError {
  return new TransportError(
    'WT_PORT_IN_USE',
    `${what} is held by another process`,
    'Stop that process, or pass a different port.',
  )
}

/** Throws when a plain UDP bind of `port` on `host` fails because something holds it. */
export async function assertUdpPortFree(port: number, host: string): Promise<void> {
  if (port === 0) return
  const probe = createSocket(host.includes(':') ? 'udp6' : 'udp4')
  await new Promise<void>((resolve, reject) => {
    probe.once('error', (e: NodeJS.ErrnoException) => {
      probe.close()
      reject(e.code === 'EADDRINUSE' ? held(`UDP port ${port} on ${host}`) : e)
    })
    probe.bind(port, host, () => probe.close(resolve))
  })
}

/** True when something accepts a TCP connection at `host:port` within the budget. */
function answers(host: string, port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = connect({ host, port })
    const done = (value: boolean): void => {
      socket.destroy()
      resolve(value)
    }
    socket.setTimeout(CONNECT_BUDGET_MS, () => done(false))
    socket.once('connect', () => done(true))
    // Refused is the free case; an address that does not exist on this machine is too.
    socket.once('error', () => done(false))
  })
}

/**
 * Throws when anything answers on `port` at either loopback address. Binding `127.0.0.1`
 * alone can succeed beside a server on `::`, and that is the case a browser then walks into.
 */
export async function assertTcpPortFree(port: number): Promise<void> {
  if (port === 0) return
  for (const host of ['127.0.0.1', '::1']) {
    if (await answers(host, port)) {
      throw held(
        `TCP port ${port} (something answers on ${host.includes(':') ? `[${host}]` : host}:${port})`,
      )
    }
  }
}

/** The bind error the kernel reports, as the same code the probes raise. */
export function asPortInUse(e: unknown, what: string): unknown {
  return (e as NodeJS.ErrnoException | null)?.code === 'EADDRINUSE' ? held(what) : e
}
