/**
 * The seam's rule for `closed`: it resolves, always.
 *
 * The WebTransport specification rejects a session's `closed` when the session ends with no
 * close from the peer: a killed process, a dead path. Everything above the seam waits on
 * `closed` with `.then()`, the session to release what it holds and the client to change
 * status and reconnect, so a rejection that crossed the seam meant none of that ran and a
 * page said `connected` to a server that was gone. One mapping, used by every adapter over
 * a platform session, so the rule is not four `.catch()` calls that three files remember.
 */
import { CloseCode } from '../protocol.ts'
import type { CloseInfo } from './types.ts'

/**
 * What `closed` reports when the connection ended and the peer never said why. The code is
 * `WT_NO_ERROR` because no session close code was received, and the reference binding
 * reports a lost connection exactly as it reports a clean close, so nothing above the seam
 * may depend on telling the two apart.
 */
export function lost(said = ''): CloseInfo {
  return {
    code: CloseCode.WT_NO_ERROR,
    reason: said === '' ? 'connection lost' : `connection lost: ${said}`,
  }
}

/** A platform session's `closed`, as the seam reports it. */
export function closedOf(
  platform: Promise<{ readonly closeCode?: number; readonly reason?: string }>,
): Promise<CloseInfo> {
  return platform.then(
    (info) => ({ code: info.closeCode ?? 0, reason: info.reason ?? '' }),
    (cause: unknown) => lost(cause instanceof Error ? cause.message : ''),
  )
}
