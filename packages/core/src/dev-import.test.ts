/**
 * `transport/dev.ts` claims it evaluates nothing at import time, so importing it on a server
 * is safe. That claim is the kind a later import quietly breaks: the module now pulls in
 * `Client`, and the next person to add something will not re-derive whether it is inert.
 *
 * Checked in a **fresh process** on purpose. An in-process dynamic import returns whatever
 * the module cache already holds, so if any other test in this file's run had imported the
 * module first, the assertion would pass without importing anything - a gate that cannot
 * fail. A subprocess has no cache to hit.
 */

import { expect, test } from 'bun:test'
import { execFileSync } from 'node:child_process'
import { resolve } from 'node:path'

const DEV = resolve(import.meta.dir, 'transport/dev.ts')

/** Every browser global the module is allowed to read inside a function and not before. */
const REMOVE = "for (const k of ['location', 'WebTransport', 'fetch']) delete globalThis[k]"

test('importing the dev transport reads no browser global', () => {
  const script = `${REMOVE}
const m = await import(${JSON.stringify(DEV)})
if (typeof m.connectDev !== 'function') throw new Error('connectDev missing')
if (typeof m.devClient !== 'function') throw new Error('devClient missing')
`
  // Throws on a non-zero exit, which is the assertion: the import must survive a global
  // object with no browser in it.
  const out = execFileSync('node', ['--input-type=module', '-e', script], { encoding: 'utf8' })
  expect(out).toBe('')
})

test('the removal above actually removes them, so the test above can fail', () => {
  const script = `${REMOVE}
if (globalThis.location !== undefined) throw new Error('location survived')
if (globalThis.fetch !== undefined) throw new Error('fetch survived')
`
  expect(() => execFileSync('node', ['--input-type=module', '-e', script])).not.toThrow()
})
