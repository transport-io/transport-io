/**
 * The door's verdict, shared by every listener so a refusal means one thing on the wire.
 *
 * `authorize` answers with what it learned, which becomes `peer.data`; with `null` or a
 * `refuse(reason)`, which is a refusal; or by throwing, which is not an answer at all. The
 * difference matters to the client: a refusal is about the request, the same request would
 * be refused again, and a client that reconnects on its own stops. A throw is about the
 * server, a verification backend that is down, and must stay retryable, so it closes the
 * session without the code that says refused (D144).
 */
import { DEFAULT_REFUSAL_REASON, TransportError } from './errors.ts'
import { CloseCode, REFUSAL_REASON_MAX_BYTES } from './protocol.ts'
import type { Authorize, ConnectRequest } from './transport/types.ts'

/** A refusal that says why. Made by `refuse`, returned from `authorize`. */
export class Refusal {
  readonly reason: string

  constructor(reason: string) {
    this.reason = reason
  }
}

/**
 * Refuses a peer from `authorize`, with a reason the client can branch on: it arrives as
 * `RefusedError.reason` from `connect()` and as `refused.reason` on the snapshot. The reason
 * is the session's close reason, so it is short: at most 123 bytes of UTF-8, the WebSocket
 * mapping's cap, and it throws here rather than arrive cut and no longer equal to what the
 * client compares it with. `authorize` returning `null` is `refuse('refused')`.
 */
export function refuse(reason: string): Refusal {
  const bytes = new TextEncoder().encode(reason).byteLength
  if (bytes === 0 || bytes > REFUSAL_REASON_MAX_BYTES) {
    throw new TransportError(
      'WT_VALIDATION_FAILED',
      `a refusal reason is 1 to ${REFUSAL_REASON_MAX_BYTES} bytes, and this one is ${bytes}`,
      "Use a short code the client can compare, 'expired' or 'banned', and keep prose for the page that shows it.",
    )
  }
  return new Refusal(reason)
}

export type Verdict<D> =
  | { readonly accepted: true; readonly data: D | undefined }
  | { readonly accepted: false; readonly code: number; readonly reason: string }

/** Runs `authorize` for one request. Never throws: a throw inside it is a verdict too. */
export async function decide<D>(
  authorize: Authorize<D> | undefined,
  request: () => ConnectRequest,
): Promise<Verdict<D>> {
  if (authorize === undefined) return { accepted: true, data: undefined }
  let answer: D | Refusal | null
  try {
    answer = await authorize(request())
  } catch {
    // Not a refusal: nothing was decided about this peer, and the next attempt may be.
    return { accepted: false, code: CloseCode.WT_NO_ERROR, reason: 'authorize failed' }
  }
  if (answer === null) {
    return { accepted: false, code: CloseCode.WT_UNAUTHORIZED, reason: DEFAULT_REFUSAL_REASON }
  }
  if (answer instanceof Refusal) {
    return { accepted: false, code: CloseCode.WT_UNAUTHORIZED, reason: answer.reason }
  }
  return { accepted: true, data: answer }
}
