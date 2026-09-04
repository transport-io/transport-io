/**
 * The case that matters is the last one: a relative import of a Node-only module from a
 * file that Bun will load. The Biome rule this replaces matched three package specifiers,
 * so that import - the more likely of the two mistakes, because nobody reaches for the raw
 * package name when the wrapper is next door - passed `biome ci` cleanly.
 */
import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import {
  findBoundaryViolations,
  findTimerViolations,
  isNodeOnly,
  scan,
  scanTimers,
} from './check-boundaries.ts'

describe('a module Bun may load must not reach the transport', () => {
  test('the package specifier is caught, as it always was', () => {
    const v = findBoundaryViolations(
      'a.test.ts',
      "import { WebTransport } from '@fails-components/webtransport'\n",
    )
    expect(v.map((x) => x.specifier)).toEqual(['@fails-components/webtransport'])
  })

  test('a RELATIVE import of a Node-only module is caught - the hole in the Biome rule', () => {
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

  test('a Node-only module may import whatever it likes', () => {
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

  test('and the detector still fires against a real module, not only against fixtures', () => {
    // A clean scan over the real tree proves nothing unless the finder would still catch a
    // violation in a file of that shape. Take the largest non-Node module there is and give
    // it the import the rule exists to forbid.
    const path = 'packages/core/src/session.ts'
    const real = readFileSync(path, 'utf8')
    const broken = `import { connectHttp3 } from './transport/fails.node.ts'\n${real}`
    expect(findBoundaryViolations(path, broken).length).toBeGreaterThan(0)
  })
})

/**
 * The timer rule, which exists because `dispose()` was a list and a list was missed twice.
 * The fixtures are the two halves of the property: a teardown makes the rule apply, and its
 * absence makes it not apply.
 */
describe('a module with a teardown may not create its own timers', () => {
  const withTeardown = (body: string): string =>
    `class Thing {\n  dispose(): void {\n    this.stop()\n  }\n${body}\n}\n`

  test('a retained setInterval in a class that disposes is caught', () => {
    const v = findTimerViolations(
      'packages/core/src/thing.ts',
      withTeardown('  start(): void {\n    this.t = setInterval(this.sweep, 100)\n  }'),
    )
    expect(v.map((x) => x.specifier)).toEqual(['setInterval'])
  })

  test('a setTimeout is caught too, retained or not', () => {
    const v = findTimerViolations(
      'packages/core/src/thing.ts',
      withTeardown('  arm(): void {\n    setTimeout(() => this.fail(), 5000)\n  }'),
    )
    expect(v.map((x) => x.specifier)).toEqual(['setTimeout'])
  })

  test('the registry itself is allowed, because it defines no teardown', () => {
    const v = findTimerViolations(
      'packages/core/src/timers.ts',
      'export class OwnedTimers {\n  after(ms: number) {\n    return setTimeout(() => {}, ms)\n  }\n}\n',
    )
    expect(v).toEqual([])
  })

  test('a module with no teardown is not the subject of this rule', () => {
    const v = findTimerViolations(
      'packages/core/src/other.ts',
      'export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))\n',
    )
    expect(v).toEqual([])
  })

  test('a comment naming a timer is documentation, not a call', () => {
    const v = findTimerViolations(
      'packages/core/src/thing.ts',
      withTeardown('  // setTimeout is not allowed here; use OwnedTimers.\n  arm(): void {}'),
    )
    expect(v).toEqual([])
  })

  test('tests and benches own nothing past their own run', () => {
    const body = withTeardown('  arm(): void {\n    setTimeout(() => {}, 1)\n  }')
    expect(findTimerViolations('packages/core/src/thing.test.ts', body)).toEqual([])
    expect(findTimerViolations('packages/core/src/bench/thing.ts', body)).toEqual([])
  })

  test('the repository is clean, and the sweep looked at something', () => {
    expect(scanTimers()).toEqual([])
  })
})
