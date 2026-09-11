/**
 * The rules a tutorial page is held to, each proven on a fixture that breaks it. The two
 * that carry the weight: a hunk's pre-image must be found exactly once, tested from both
 * sides, and a reference block never wins over the reconstruction it is checked against.
 */
import { describe, expect, test } from 'bun:test'
import { applyHunk, parseHunk, reconstruct } from './tutorial-blocks.ts'

const fence = (info: string, body: string): string => `\`\`\`${info}\n${body}\n\`\`\``
const complete = (file: string, body: string): string => fence(`ts file=${file}`, body)
const change = (file: string, body: string): string =>
  fence(`diff lang="ts" file=${file}`, body)
const ref = (file: string, body: string): string =>
  `<details>\n<summary>${file}</summary>\n\n${fence(`ts file=${file} ref`, body)}\n\n</details>`

const opts = {
  allowed: (f: string) => f === 'a.ts' || f === 'b.ts',
  readRepository: (p: string) => (p === 'repo/x.ts' ? 'one\ntwo\nthree\nfour\n' : undefined),
}

const page = (...parts: string[]): string => parts.join('\n\n')

describe('a hunk is placed by its pre-image, exactly once', () => {
  const file = 'const a = 1\nconst b = 2\nconst c = 3\nexport {}'

  test('one match applies, and the file is the first appearance plus the change', () => {
    const r = reconstruct(
      page(
        complete('a.ts', file),
        change('a.ts', ' const b = 2\n+const b2 = 22\n const c = 3'),
      ),
      opts,
    )
    expect(r.problems).toEqual([])
    expect(r.files.get('a.ts')).toBe(
      'const a = 1\nconst b = 2\nconst b2 = 22\nconst c = 3\nexport {}',
    )
  })

  test('a hunk that matches nothing fails, naming the block and the line it could not place', () => {
    const r = reconstruct(
      page(complete('a.ts', file), change('a.ts', ' const b = 2\n-const z = 9\n+const z = 10')),
      opts,
    )
    expect(r.problems).toHaveLength(1)
    expect(r.problems[0]).toContain('line 8: the change to a.ts matches nothing')
    expect(r.problems[0]).toContain('"const z = 9"')
    // Nothing was applied.
    expect(r.files.get('a.ts')).toBe(file)
  })

  test('a hunk that matches twice fails, naming both places', () => {
    const twice = 'x\ny\nx\ny\nend'
    const r = reconstruct(
      page(complete('a.ts', twice), change('a.ts', ' x\n+inserted\n y')),
      opts,
    )
    expect(r.problems).toHaveLength(1)
    expect(r.problems[0]).toContain('matches 2 places, at lines 1 and 3')
    expect(r.files.get('a.ts')).toBe(twice)
  })

  test('every line present but not as one run is still no match, and the message says so', () => {
    const out = applyHunk('a\nb\nc', { pre: ['c', 'a'], post: ['c', 'a', 'd'] })
    expect(out).toEqual({
      error: expect.stringContaining('every line of it is in the file, but not as one run'),
    })
  })

  test('a hunk with no context and nothing removed cannot be placed', () => {
    expect(parseHunk('+only additions')).toEqual({
      error: 'the hunk has no context and removes nothing, so it cannot be placed',
    })
  })

  test('a hunk header or an unprefixed line is refused', () => {
    expect(parseHunk('@@ -1,2 +1,3 @@\n a')).toMatchObject({
      error: expect.stringContaining('header'),
    })
    expect(parseHunk(' a\nb')).toMatchObject({
      error: expect.stringContaining('no +, - or space prefix'),
    })
  })

  test('a change to a file that does not exist yet fails', () => {
    const r = reconstruct(page(change('a.ts', ' x\n+y')), opts)
    expect(r.problems).toEqual(['line 1: a change block for a.ts before the file exists'])
  })
})

describe('a reference block is checked and never adopted', () => {
  const first = 'const a = 1\nexport {}'
  const hunk = ' const a = 1\n+const b = 2\n export {}'
  const built = 'const a = 1\nconst b = 2\nexport {}'

  test('a reference that agrees passes', () => {
    const r = reconstruct(
      page(complete('a.ts', first), change('a.ts', hunk), ref('a.ts', built)),
      opts,
    )
    expect(r.problems).toEqual([])
    expect(r.files.get('a.ts')).toBe(built)
  })

  test('a reference that disagrees fails at the differing line, and the reconstruction stands', () => {
    const wrong = 'const a = 1\nconst b = 3\nexport {}'
    const r = reconstruct(
      page(complete('a.ts', first), change('a.ts', hunk), ref('a.ts', wrong)),
      opts,
    )
    expect(r.problems).toHaveLength(1)
    expect(r.problems[0]).toContain(
      'line 15: the reference block for a.ts disagrees with the reconstruction at its line 2',
    )
    expect(r.problems[0]).toContain('"const b = 3"')
    expect(r.files.get('a.ts')).toBe(built)
  })

  test('a reference outside a collapsed block is refused, because it would print the file in full', () => {
    const r = reconstruct(page(complete('a.ts', first), fence('ts file=a.ts ref', first)), opts)
    expect(r.problems).toEqual([
      'line 6: the reference block for a.ts is outside a <details> block, so it prints the file in full',
    ])
  })

  test('a complete block inside a collapsed block must say it is a reference', () => {
    const r = reconstruct(
      page(
        complete('a.ts', first),
        `<details>\n<summary>a.ts</summary>\n\n${complete('a.ts', first)}\n\n</details>`,
      ),
      opts,
    )
    expect(r.problems).toEqual([
      'line 9: the block for a.ts inside a <details> block is not tagged ref, so it would count as the file',
    ])
  })
})

describe('a file appears complete once', () => {
  test('a second complete block for the same file fails', () => {
    const r = reconstruct(page(complete('a.ts', 'x'), complete('a.ts', 'y')), opts)
    expect(r.problems).toEqual([
      'line 5: a second complete block for a.ts; after the first appearance a file changes only by hunks',
    ])
    expect(r.files.get('a.ts')).toBe('x')
  })

  test('a file the example does not have is refused', () => {
    const r = reconstruct(page(complete('c.ts', 'x')), opts)
    expect(r.problems).toEqual(['line 1: writes c.ts, which the example does not have'])
  })
})

describe('an excerpt is a verbatim run of a repository file', () => {
  test('a contiguous run passes and a rearranged one fails', () => {
    const ok = reconstruct(fence('ts excerpt=repo/x.ts', 'two\nthree'), opts)
    expect(ok.problems).toEqual([])
    const bad = reconstruct(fence('ts excerpt=repo/x.ts', 'two\nfour'), opts)
    expect(bad.problems).toEqual([
      'line 1: excerpt is not a contiguous run of repo/x.ts; it starts with "two"',
    ])
  })

  test('an excerpt of a file that does not exist fails', () => {
    const r = reconstruct(fence('ts excerpt=repo/missing.ts', 'two'), opts)
    expect(r.problems).toEqual(['line 1: excerpt of repo/missing.ts, which does not exist'])
  })
})
