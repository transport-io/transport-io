/**
 * The case that matters is the last one: a relative import of a Node-only module from a
 * file that Bun will load. The Biome rule this replaces matched three package specifiers,
 * so that import — the more likely of the two mistakes, because nobody reaches for the raw
 * package name when the wrapper is next door — passed `biome ci` cleanly.
 */
import { describe, expect, test } from 'bun:test'
import { findBoundaryViolations, isNodeOnly, scan } from './check-boundaries.ts'

describe('a module Bun may load must not reach the transport', () => {
  test('the package specifier is caught, as it always was', () => {
    const v = findBoundaryViolations(
      'a.test.ts',
      "import { WebTransport } from '@fails-components/webtransport'\n",
    )
    expect(v.map((x) => x.specifier)).toEqual(['@fails-components/webtransport'])
  })

  test('a RELATIVE import of a Node-only module is caught — the hole in the Biome rule', () => {
    const v = findBoundaryViolations(
      'packages/core/src/thing.test.ts',
      "import { connectHttp3 } from './transport/fails.node.ts'\n",
    )
    expect(v.map((x) => x.specifier)).toEqual(['./transport/fails.node.ts'])
  })

  test('a dynamic import counts too', () => {
    const v = findBoundaryViolations('a.ts', "const m = await import('@moq/web-transport')\n")
    expect(v.length).toBe(1)
  })

  test('a re-export counts too', () => {
    const v = findBoundaryViolations(
      'a.ts',
      "export { listenHttp3 } from '../transport/fails.node.ts'\n",
    )
    expect(v.length).toBe(1)
  })

  test('a Node-only module may import whatever it likes — that is the point of the name', () => {
    expect(isNodeOnly('x.node.ts')).toBe(true)
    expect(isNodeOnly('x.node.test.ts')).toBe(true)
    expect(isNodeOnly('x.test.ts')).toBe(false)
    expect(
      findBoundaryViolations('bench.node.ts', "import '@fails-components/webtransport'\n"),
    ).toEqual([])
  })

  test('an ordinary import is not flagged', () => {
    const v = findBoundaryViolations('a.ts', "import { Session } from './session.ts'\n")
    expect(v).toEqual([])
  })

  test('the repository as it stands has no violation', () => {
    expect(scan()).toEqual([])
  })
})
