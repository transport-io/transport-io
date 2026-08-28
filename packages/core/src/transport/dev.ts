/**
 * The development-only browser connection.
 *
 * A pinned certificate has to reach the browser as bytes, and in development the only place
 * those bytes exist is the process that minted the certificate. `transport-io dev` serves
 * them at a fixed endpoint and this fetches them, which closes the one hop the documentation
 * used to end at: `declare const certificateHash: Uint8Array`.
 *
 * Fetching a certificate hash from an endpoint and trusting whatever comes back is a
 * development affordance and nothing else. It must therefore be impossible to turn on in
 * production by accident, and "impossible" here is a property of the code rather than a
 * convention anyone has to follow:
 *
 *   - it refuses unless the page itself is on a loopback origin, and
 *   - it refuses unless the WebTransport URL it was handed is also loopback.
 *
 * A bundle that ships to production therefore cannot connect through this function, whatever
 * anyone's build configuration says. An `NODE_ENV` check would not give that: the value is
 * whatever the bundler substituted, it is routinely wrong, and it is invisible at runtime.
 * A hostname cannot be got wrong.
 *
 * Nothing here is imported at module scope, so importing this file on a server is safe.
 */
import { TransportError } from '../errors.ts'
import { connectBrowser } from './browser.ts'
import type { Connection } from './types.ts'

/** Where `transport-io dev` publishes the hash. Fixed, so neither side configures it. */
export const DEV_ENDPOINT = '/.well-known/transport-io-dev'

/**
 * `localhost` resolves to a loopback address by specification, and the two literals are
 * loopback by definition. Nothing else qualifies, including a hostname an attacker controls
 * that happens to resolve to 127.0.0.1: this is a check on what the page and the URL say,
 * which is what makes it decidable without a DNS round trip.
 */
const LOOPBACK: ReadonlySet<string> = new Set(['localhost', '127.0.0.1', '[::1]', '::1'])

function refuse(what: string, host: string): never {
  throw new TransportError(
    'WT_DEV_ONLY',
    `connectDev() refuses a non-loopback ${what} (${host === '' ? '<none>' : host})`,
    'connectDev fetches a certificate hash from the page origin and is for local development only. Use connectBrowser with your own certificateHash, or a real certificate, anywhere else.',
  )
}

/** The shape `transport-io dev` serves. Kept narrow so a wrong endpoint fails loudly. */
interface DevManifest {
  readonly sha256: readonly number[]
  readonly url: string
}

export interface DevConnectOptions {
  /** Overrides the endpoint. For tests and for a dev server on another path. */
  readonly endpoint?: string
}

/**
 * Connects using the certificate `transport-io dev` minted, fetched from the page origin.
 *
 * The WebTransport URL comes from the same response, so the page never hardcodes a port and
 * cannot drift out of step with the server the CLI started.
 */
export async function connectDev(opts: DevConnectOptions = {}): Promise<Connection> {
  const loc = (globalThis as { location?: { hostname?: string } }).location
  if (loc === undefined) {
    throw new TransportError(
      'WT_DEV_ONLY',
      'connectDev() needs a browser: there is no location to check',
      'Use connectBrowser in a browser, or connectHttp3 from Node.',
    )
  }
  const pageHost = loc.hostname ?? ''
  if (!LOOPBACK.has(pageHost)) refuse('page origin', pageHost)

  const endpoint = opts.endpoint ?? DEV_ENDPOINT
  const res = await fetch(endpoint)
  if (!res.ok) {
    throw new TransportError(
      'WT_DEV_ONLY',
      `no dev manifest at ${endpoint} (HTTP ${res.status})`,
      'Start the server with `npx transport-io dev`, which serves it.',
    )
  }
  const manifest = (await res.json()) as DevManifest
  if (!Array.isArray(manifest.sha256) || typeof manifest.url !== 'string') {
    throw new TransportError(
      'WT_DEV_ONLY',
      `the dev manifest at ${endpoint} is not {sha256, url}`,
      'Something other than `transport-io dev` is serving that path.',
    )
  }

  // The URL is checked as well as the page, because the manifest is data from the network
  // and a page served over loopback could still be handed a remote target.
  let targetHost = ''
  try {
    targetHost = new URL(manifest.url).hostname
  } catch {
    refuse('WebTransport URL', manifest.url)
  }
  if (!LOOPBACK.has(targetHost)) refuse('WebTransport URL', targetHost)

  return await connectBrowser({
    url: manifest.url,
    certificateHash: Uint8Array.from(manifest.sha256),
  })
}
