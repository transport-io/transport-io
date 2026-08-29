/**
 * Argument parsing, and the bug that shipped in it.
 *
 * `transport-io dev ./server.ts` took `dev` as the entry file, because the parser started at
 * the command word and the first non-flag argument wins. It failed with "Cannot find module
 * .../dev", which names something the user never typed.
 */
import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import { parseArgs } from './main.node.ts'

describe('the command word is not the entry', () => {
  test('dev with an entry keeps the entry', () => {
    assert.equal(parseArgs(['dev', './server.ts']).entry, './server.ts')
  })

  test('dev with no entry has no entry', () => {
    assert.equal(parseArgs(['dev']).entry, undefined)
  })

  test('dev --demo takes no entry from the flag', () => {
    const a = parseArgs(['dev', '--demo'])
    assert.equal(a.demo, true)
    assert.equal(a.entry, undefined)
  })

  test('flags after the entry still parse', () => {
    const a = parseArgs(['dev', './server.ts', '--port', '3001', '--static', './out'])
    assert.equal(a.entry, './server.ts')
    assert.equal(a.port, 3001)
    assert.equal(a.staticDir, './out')
  })
})
