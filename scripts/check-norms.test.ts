/**
 * The gate's own tests. It is shallow by design — it does not check that a test is any
 * good — so the only things worth asserting are the three ways it can be evaded: writing a
 * MUST with no marker, pointing a marker at a file that says nothing about it, and reusing
 * an id so two statements appear to be one.
 */
import { describe, expect, test } from 'bun:test'
import { parse, uncovered } from './check-norms.ts'

const marker = (id: string, target: string): string => `<!-- norm: ${id} -> ${target} -->`

describe('a normative statement without a marker is caught', () => {
  test('a bare MUST is uncovered', () => {
    const { statements, markers } = parse('X.md', 'A peer MUST send a handshake.\n')
    expect(statements.length).toBe(1)
    expect(uncovered(statements, markers).length).toBe(1)
  })

  test('a marker on the next line covers it', () => {
    const { statements, markers } = parse(
      'X.md',
      `A peer MUST send a handshake.\n${marker('a', 'f.ts')}\n`,
    )
    expect(uncovered(statements, markers)).toEqual([])
  })

  test('one marker covers a run of consecutive MUSTs, so a table needs one not twelve', () => {
    const rows = Array.from({ length: 6 }, (_, i) => `| f${i} | MUST be zero. |`).join('\n')
    const { statements, markers } = parse('X.md', `${rows}\n${marker('a', 'f.ts')}\n`)
    expect(statements.length).toBe(6)
    expect(uncovered(statements, markers)).toEqual([])
  })

  test('a marker far above does not reach down to a later statement', () => {
    const filler = Array.from({ length: 60 }, () => 'ordinary prose').join('\n')
    const { statements, markers } = parse(
      'X.md',
      `${marker('a', 'f.ts')}\n${filler}\nA peer MUST x.\n`,
    )
    expect(uncovered(statements, markers).length).toBe(1)
  })

  test("API.md's bold guarantees count, since it states them without MUST", () => {
    const { statements } = parse(
      'API.md',
      '**The lane lives in the contract, never at the call site.** More prose.\n',
    )
    expect(statements.length).toBe(1)
  })

  test('ordinary prose using "never" is not dragged in', () => {
    const { statements } = parse('API.md', 'This is never going to be a normative claim.\n')
    expect(statements).toEqual([])
  })

  test('the RFC-2119 boilerplate is not itself a normative statement', () => {
    const { statements } = parse(
      'PROTOCOL.md',
      '"MUST", "MUST NOT", "SHOULD" and "MAY" carry their usual specification force.\n',
    )
    expect(statements).toEqual([])
  })
})

describe('a marker records where the proof is', () => {
  test('an UNPROVEN marker is recognised and carries its reason', () => {
    const { markers } = parse('X.md', `${marker('a', 'UNPROVEN: nothing drives it yet')}\n`)
    expect(markers[0]?.unproven).toBe(true)
    expect(markers[0]?.target).toContain('nothing drives it yet')
  })

  test('a normal marker records the file it names', () => {
    const { markers } = parse('X.md', `${marker('a', 'packages/core/src/x.test.ts')}\n`)
    expect(markers[0]?.unproven).toBe(false)
    expect(markers[0]?.target).toBe('packages/core/src/x.test.ts')
  })

  test('the real documents parse into markers, not into nothing', () => {
    // Guards against a marker syntax change silently turning the whole gate into a no-op
    // that reports zero statements and zero markers and exits 0.
    const proto = parse('PROTOCOL.md', require('node:fs').readFileSync('PROTOCOL.md', 'utf8'))
    expect(proto.markers.length).toBeGreaterThan(20)
    expect(proto.statements.length).toBeGreaterThan(20)
  })
})
