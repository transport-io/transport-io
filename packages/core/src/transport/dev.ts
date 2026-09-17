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
 * This module evaluates nothing at import time. It reads `location`, `fetch` and
 * `WebTransport` inside `connectDev`, never at module scope, so importing it on a server
 * is safe. `Client` is imported here and that stays true: constructing one performs no
 * I/O and touches no browser global. `dev-import.test.ts` holds it, because the property
 * is the kind that a later import quietly breaks.
 */
import { Client, type ClientOptions } from '../client.ts'
import type { AnyMap, Registered } from '../contract.ts'
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

function notLoopback(what: string, host: string): never {
  throw new TransportError(
    'WT_DEV_ONLY',
    `the dev manifest is refused for a non-loopback ${what} (${host === '' ? '<none>' : host})`,
    'connectDev and fetchDevManifest trust a certificate hash served over plain HTTP and are for local development only. Use connectBrowser with your own certificateHash, or a real certificate, anywhere else.',
  )
}

/** The shape `transport-io dev` serves. Kept narrow so a wrong endpoint fails loudly. */
export interface DevManifest {
  /** SHA-256 over the DER of the certificate the dev command minted. */
  readonly sha256: readonly number[]
  /** The WebTransport URL the dev command is listening on. Loopback, checked. */
  readonly url: string
  /** ISO 8601. Absent when an older `transport-io dev` is serving the manifest. */
  readonly expiresAt?: string
}

/** What the WebTransport URL's query carries, which is where a browser can put a token. */
export type DevQuery = Readonly<Record<string, string>> | URLSearchParams

export interface DevManifestOptions {
  /**
   * Overrides the endpoint. For tests, for a dev server on another path, and for tooling
   * outside a browser, where it has to be an absolute loopback URL since there is no page
   * origin to be relative to.
   */
  readonly endpoint?: string
}

export interface DevConnectOptions extends DevManifestOptions {
  /**
   * Added to the WebTransport URL's query, where the listener's `authorize` reads it. A
   * function is called on every attempt, the first and each reconnect, so a token refreshed
   * since the last attempt is the one sent.
   */
  readonly query?: DevQuery | (() => DevQuery | Promise<DevQuery>)
}

/**
 * The manifest `transport-io dev` serves, fetched and checked: what `connectDev` dials from,
 * and what development tooling, a plugin that re-serves it from another dev server, reads.
 *
 * Every refusal `connectDev` makes about where it may be used is made here, so nothing built
 * on this can reach production either. In a browser the page has to be on loopback. Outside
 * one there is no page, so the endpoint has to be an absolute loopback URL. Either way the
 * WebTransport URL in the manifest has to be loopback, and a certificate past its validity
 * is `WT_CERT_EXPIRED`.
 */
export async function fetchDevManifest(opts: DevManifestOptions = {}): Promise<DevManifest> {
  const loc = (globalThis as { location?: { hostname?: string } }).location
  const endpoint = opts.endpoint ?? DEV_ENDPOINT
  if (loc !== undefined) {
    const pageHost = loc.hostname ?? ''
    if (!LOOPBACK.has(pageHost)) notLoopback('page origin', pageHost)
  } else {
    let endpointHost = ''
    try {
      endpointHost = new URL(endpoint).hostname
    } catch {
      throw new TransportError(
        'WT_DEV_ONLY',
        `there is no page origin for ${endpoint} to be relative to`,
        'Outside a browser, pass an absolute loopback endpoint, for example http://127.0.0.1:3000/.well-known/transport-io-dev.',
      )
    }
    if (!LOOPBACK.has(endpointHost)) notLoopback('manifest endpoint', endpointHost)
  }

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

  /**
   * Expiry is checked before anything dials, and this is the whole reason the manifest
   * carries it.
   *
   * A pinned certificate is capped at 14 days, so it expiring is normal operation rather
   * than a fault. Once it has, the browser's failure is indistinguishable from a server that
   * is down or a hash that never matched - one `WebTransportError`, no properties. Here we
   * do not have to infer anything: the process that minted the certificate published when it
   * expires, so this is a fact rather than a guess, and it is the one path a newcomer takes.
   */
  if (manifest.expiresAt !== undefined) {
    const expires = Date.parse(manifest.expiresAt)
    if (!Number.isNaN(expires) && expires <= Date.now()) {
      throw new TransportError(
        'WT_CERT_EXPIRED',
        `the pinned development certificate expired on ${new Date(expires).toUTCString()}`,
        'Restart `npx transport-io dev`, which mints a new one, then reload this page so it picks up the new hash.',
      )
    }
  }

  // The URL is checked as well as the page, because the manifest is data from the network
  // and a page served over loopback could still be handed a remote target.
  let targetHost = ''
  try {
    targetHost = new URL(manifest.url).hostname
  } catch {
    notLoopback('WebTransport URL', manifest.url)
  }
  if (!LOOPBACK.has(targetHost)) notLoopback('WebTransport URL', targetHost)
  return manifest
}

/**
 * Connects using the certificate `transport-io dev` minted, fetched from the page origin.
 *
 * The WebTransport URL comes from the same response, so the page never hardcodes a port and
 * cannot drift out of step with the server the CLI started.
 */
export async function connectDev(opts: DevConnectOptions = {}): Promise<Connection> {
  if ((globalThis as { location?: unknown }).location === undefined) {
    throw new TransportError(
      'WT_DEV_ONLY',
      'connectDev() needs a browser: there is no location to check',
      'Use connectBrowser in a browser, or connectHttp3 from Node.',
    )
  }
  const manifest = await fetchDevManifest(opts)

  const url = new URL(manifest.url)
  const query = typeof opts.query === 'function' ? await opts.query() : opts.query
  if (query !== undefined) {
    const pairs = query instanceof URLSearchParams ? query : Object.entries(query)
    for (const [key, value] of pairs) url.searchParams.set(key, value)
  }

  // No probe: the manifest fetch above already proved the dev server answers over TCP, the
  // WebTransport port is UDP-only on loopback, and expiry was ruled out before dialling.
  return await connectBrowser({
    url: url.href,
    certificateHash: Uint8Array.from(manifest.sha256),
    probe: false,
  })
}

/** Everything `Client` needs except `connect`, which is what this module supplies. */
export interface DevClientOptions extends Omit<ClientOptions, 'connect'>, DevConnectOptions {}

/**
 * A connected client against the certificate `transport-io dev` minted, in one call.
 *
 * The same refusals apply as to `connectDev`, because it is `connectDev` doing the
 * connecting: a bundle that reaches production cannot connect through this either.
 *
 * **Pass the map explicitly, or register it.** See `browserClient` for why the type argument
 * is not inferred from `contract`, and D100 for the measurement behind it.
 */
export async function devClient<M extends AnyMap = Registered>(
  options: DevClientOptions,
): Promise<Client<M>> {
  const client = new Client<M>({ ...options, connect: () => connectDev(options) })
  await client.connect()
  return client
}
