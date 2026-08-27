/**
 * The rewriter runs over `PROTOCOL.md`, which is the document this project cares most about
 * being exactly right, so it is tested against fabricated input for the edge cases and
 * against the real files for the thing that actually matters: that no link is dropped and
 * no code sample is edited.
 */
import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { SITE_PAGES, transformRootMarkdown } from './transform.ts'

const ROOT = join(import.meta.dirname, '../../..')

describe('the title', () => {
  test('comes from the level-one heading, which is then removed', () => {
    const r = transformRootMarkdown('# transport-io API\n\nBody text.\n', 'API.md')
    expect(r.title).toBe('transport-io API')
    expect(r.body).not.toContain('# transport-io API')
    expect(r.body).toContain('Body text.')
  })

  test('a file with no heading is an error, not a page titled undefined', () => {
    expect(() => transformRootMarkdown('no heading here\n', 'X.md')).toThrow(
      /level-one heading/,
    )
  })
})

describe('norm markers', () => {
  test('are removed with their line, leaving the statement intact', () => {
    const r = transformRootMarkdown(
      '# T\n\nA receiver MUST accept it.\n<!-- norm: some-id -> packages/core/src/x.test.ts -->\nAnd then continue.\n',
      'PROTOCOL.md',
    )
    expect(r.body).not.toContain('norm:')
    expect(r.body).toContain('A receiver MUST accept it.')
    expect(r.body).toContain('And then continue.')
  })
})

describe('links', () => {
  test('a document with a page becomes a site link', () => {
    const r = transformRootMarkdown('# T\n\nSee [the wire](PROTOCOL.md).\n', 'API.md')
    expect(r.body).toContain('](/protocol/)')
  })

  test('an anchor survives the rewrite', () => {
    const r = transformRootMarkdown('# T\n\n[caps](PROTOCOL.md#5-1-field-budget)\n', 'API.md')
    expect(r.body).toContain('](/protocol/#5-1-field-budget)')
  })

  test('a document with no page becomes an absolute GitHub link, never a dead one', () => {
    const r = transformRootMarkdown(
      '# T\n\n[why](DECISIONS.md) and [adr](ADR/0012-x.md)\n',
      'API.md',
    )
    expect(r.body).toContain(
      'https://github.com/transport-io/transport-io/blob/main/DECISIONS.md',
    )
    expect(r.body).toContain(
      'https://github.com/transport-io/transport-io/blob/main/ADR/0012-x.md',
    )
  })

  test('an asset becomes a raw URL', () => {
    const r = transformRootMarkdown('# T\n\n![m](assets/brand/mark.svg)\n', 'README.md')
    expect(r.body).toContain(
      'https://raw.githubusercontent.com/transport-io/transport-io/main/assets/brand/mark.svg',
    )
  })

  test('absolute, mailto and bare-anchor targets are left alone', () => {
    const src =
      '# T\n\n[a](https://example.com) [b](mailto:x@y.z) [c](#section) [d](/already)\n'
    const r = transformRootMarkdown(src, 'API.md')
    expect(r.rewritten).toEqual([])
    expect(r.body).toContain('](https://example.com)')
    expect(r.body).toContain('](#section)')
  })

  test('a link-shaped string inside a code fence is not touched', () => {
    const src =
      '# T\n\n```ts\n// see [docs](PROTOCOL.md)\nconst x = 1\n```\n\nAnd [real](PROTOCOL.md).\n'
    const r = transformRootMarkdown(src, 'API.md')
    // The sample keeps its original text; only the prose link moved.
    expect(r.body).toContain('// see [docs](PROTOCOL.md)')
    expect(r.body).toContain('And [real](/protocol/).')
    expect(r.rewritten).toHaveLength(1)
  })
})

describe('against the real documents', () => {
  for (const file of Object.keys(SITE_PAGES)) {
    test(`${file} transforms with every relative link accounted for`, () => {
      const source = readFileSync(join(ROOT, file), 'utf8')
      const r = transformRootMarkdown(source, file)

      expect(r.title.length).toBeGreaterThan(0)
      expect(r.body).not.toContain('<!-- norm:')

      // Nothing relative may survive. This is the assertion that matters: a rewriter that
      // silently skipped a pattern would leave a link that 404s on the site, and the page
      // would look fine until someone clicked it.
      const survivors = [...r.body.matchAll(/\]\(([^)\s]+)\)/g)]
        .map((m) => m[1] as string)
        .filter((t) => !/^(https?:|mailto:|#|\/)/.test(t))
      expect(survivors).toEqual([])
    })
  }

  test('the rewriter is exercised by the corpus, not merely run over it', () => {
    // `API.md` and `PROTOCOL.md` happen to carry no relative links today, so their
    // "nothing survives" assertions above pass over an empty set. True, and worth nothing
    // on its own. This is the floor that makes the pair mean something.
    const total = Object.keys(SITE_PAGES).reduce(
      (n, f) =>
        n + transformRootMarkdown(readFileSync(join(ROOT, f), 'utf8'), f).rewritten.length,
      0,
    )
    expect(total).toBeGreaterThanOrEqual(2)
  })

  test('the code samples come through byte for byte', () => {
    const source = readFileSync(join(ROOT, 'API.md'), 'utf8')
    const fences = (s: string): string[] =>
      [...s.matchAll(/^```[\s\S]*?^```/gm)].map((m) => m[0])
    const before = fences(source)
    const after = fences(transformRootMarkdown(source, 'API.md').body)
    expect(after).toEqual(before)
    expect(before.length).toBeGreaterThan(5)
  })
})
