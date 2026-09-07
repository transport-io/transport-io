/**
 * The one signal left after a WebTransport handshake fails.
 *
 * A browser reports the same error for a blocked UDP path, a dead server, a wrong pinned
 * hash and an expired certificate, and it does so on purpose, so nothing on that error can
 * be branched on. What can be observed is whether the same origin answers over TCP. If it
 * does, the server is up and its certificate is trusted for HTTPS, and only the QUIC path is
 * failing. That is the condition a firewall, a VPN or a platform with no UDP ingress
 * produces, and it gets its own code so an operator can count it and a client can act on it.
 *
 * The probe runs only after `ready` has rejected, so the connected path pays nothing for it.
 * An origin that listens only on UDP never answers, which keeps the generic code and never
 * claims a blocked path on evidence it does not have.
 */
import { TransportError } from '../errors.ts'

/**
 * Any HTTP status at this path counts as an answer; a 404 proves TCP, TLS and HTTP all
 * reached a server. The path is fixed so a server that wants to count probes can serve it.
 */
export const PROBE_PATH = '/.well-known/transport-io'

/** Absolute. A probe that outlives this is treated as unanswered. */
export const PROBE_BUDGET_MS = 2000

export type ProbeOutcome = 'answered' | 'unanswered' | 'skipped'

/** The probe target for a WebTransport URL: its origin, at the fixed path. */
export function probeTarget(url: string): string | undefined {
  try {
    return `${new URL(url).origin}${PROBE_PATH}`
  } catch {
    return undefined
  }
}

/**
 * Does the target answer over HTTPS at all?
 *
 * `no-cors` so no server has to opt in, `HEAD` so no body is read, `no-store` so a cached
 * answer cannot stand in for a live one, and no credentials because the answer is the only
 * thing wanted. A runtime with no `fetch` reports `skipped`, never `unanswered`.
 */
export async function probe(
  target: string,
  budgetMs: number = PROBE_BUDGET_MS,
): Promise<ProbeOutcome> {
  const f = (globalThis as { fetch?: typeof fetch }).fetch
  if (f === undefined) return 'skipped'
  try {
    await f(target, {
      method: 'HEAD',
      mode: 'no-cors',
      cache: 'no-store',
      credentials: 'omit',
      signal: AbortSignal.timeout(budgetMs),
    })
    return 'answered'
  } catch {
    return 'unanswered'
  }
}

/**
 * The error a failed handshake becomes, given what the probe found.
 *
 * `answered` is the one case with a fact in it, and it is the only case that gets a new
 * code. `unanswered` keeps the generic code and says so in the message, because a server
 * that listens only on UDP looks exactly like this and is healthy. `skipped` is the message
 * as it always was.
 */
export function handshakeFailure(
  url: string,
  target: string | undefined,
  outcome: ProbeOutcome,
  cause: unknown,
): TransportError {
  if (outcome === 'answered' && target !== undefined) {
    return new TransportError(
      'WT_UDP_UNREACHABLE',
      `the server at ${new URL(target).origin} answers over HTTPS but the WebTransport handshake to ${url} failed`,
      'The server is running and its certificate is trusted, so only the QUIC path is failing. ' +
        'Usually UDP to it is blocked: a firewall or VPN on this network, or a platform in front ' +
        'of the server with no UDP ingress. The site works over TCP and nothing in this library ' +
        'routes around that. If you pin a certificate, a wrong or expired hash fails the same ' +
        'way, so rule that out on a network where it worked before.',
      cause,
    )
  }
  const unanswered =
    outcome === 'unanswered' && target !== undefined
      ? `, and ${target} did not answer over HTTPS within ${PROBE_BUDGET_MS} ms`
      : ''
  return new TransportError(
    'WT_HANDSHAKE_FAILED',
    `the WebTransport handshake to ${url} failed${unanswered}`,
    'The browser reports one error for every cause here, so check in this order: (1) the ' +
      'server is running and its UDP port is reachable; (2) if you pinned a certificate, ' +
      'that it has not passed its 14-day limit; (3) that the hash matches the certificate ' +
      'the server is serving - it is SHA-256 over the DER, not over cert.pem. ' +
      '`npx transport-io dev` handles all three for local development.',
    cause,
  )
}
