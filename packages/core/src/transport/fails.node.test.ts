/**
 * Pins the upstream defect this adapter exists to contain.
 *
 * `WebTransportError` omits the specification's `streamErrorCode`, so the reset code is
 * recoverable only by parsing the message string. That parsing lives in exactly one
 * function, and this test pins the format observed on the real transport so a change
 * upstream surfaces here rather than as a silently wrong error code.
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { resetCodeFromError } from './fails.node.ts'

test('the reset code is parsed out of the message, because the field does not exist', () => {
  // Observed verbatim from the reference transport on a peer-initiated abort.
  const observed = new Error('Resetstream with code:0')
  assert.equal((observed as { streamErrorCode?: number }).streamErrorCode, undefined)
  assert.equal(resetCodeFromError(observed), 0)

  assert.equal(resetCodeFromError(new Error('Resetstream with code:7')), 7)
  assert.equal(resetCodeFromError(new Error('Resetstream with code: 42')), 42)
})

test('an unparseable error yields undefined rather than a wrong code', () => {
  assert.equal(resetCodeFromError(new Error('connection lost')), undefined)
  assert.equal(resetCodeFromError('not an error'), undefined)
})
