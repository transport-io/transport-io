/**
 * Turn a repository-root markdown file into something the site can render, without
 * copying it.
 *
 * `API.md` and `PROTOCOL.md` are gated: their snippets are compiled, their constants are
 * checked against `protocol.ts`, and every normative statement names a test. A copy under
 * `site/` would be covered by none of that and would drift inside a week, so the site reads
 * the originals and adapts them here instead.
 *
 * Four adaptations, each of which exists because the original is written for GitHub:
 *
 *   1. **The title.** Starlight requires one in frontmatter; these files have none and must
 *      not grow any, because GitHub renders frontmatter as a table at the top of the page.
 *      The `#` heading is the title, and it is removed from the body because Starlight
 *      renders its own.
 *   2. **Norm markers.** `<!-- norm: id -> test -->` is machinery for `check-norms.ts`. It
 *      is invisible on GitHub and must stay invisible here.
 *   3. **Relative links.** `[PROTOCOL.md](PROTOCOL.md)` resolves on GitHub and 404s on a
 *      site. Documents that have a page become site links; everything else becomes an
 *      absolute GitHub link, so no link is ever silently dropped.
 *   4. **Relative assets**, which become raw GitHub URLs for the same reason.
 *
 * Code fences are never touched. A rewriter that edited inside a sample would corrupt the
 * one thing on these pages that has to be exactly right.
 */

/** Where each repository document lives on the site, if it lives here at all. */
export const SITE_PAGES: Readonly<Record<string, string>> = {
  'API.md': '/reference/',
  'PROTOCOL.md': '/protocol/',
  'KNOWN-ISSUES.md': '/limitations/',
}

const REPO = 'https://github.com/transport-io/transport-io'
const BLOB = `${REPO}/blob/main`
const RAW = 'https://raw.githubusercontent.com/transport-io/transport-io/main'

export interface Transformed {
  readonly title: string
  readonly body: string
  /** Every link target this rewrote, for the test and for the build log. */
  readonly rewritten: readonly { readonly from: string; readonly to: string }[]
}

/** Split on fenced code so transforms only ever see prose. */
function mapOutsideFences(source: string, fn: (chunk: string) => string): string {
  const parts = source.split(/(^```[\s\S]*?^```)/m)
  return parts.map((part, i) => (i % 2 === 1 ? part : fn(part))).join('')
}

export function transformRootMarkdown(source: string, filename: string): Transformed {
  const rewritten: { from: string; to: string }[] = []

  const heading = /^#\s+(.+)$/m.exec(source)
  if (heading?.[1] === undefined) {
    throw new Error(`${filename}: no level-one heading, so the page would have no title`)
  }
  const title = heading[1].trim()

  let body = source.replace(heading[0], '')

  // `<!-- norm: ... -->`, alone on its line, including the newline it sits on.
  body = body.replace(/^[ \t]*<!--\s*norm:[\s\S]*?-->[ \t]*\r?\n/gm, '')

  body = mapOutsideFences(body, (chunk) =>
    chunk.replace(/\]\(([^)\s]+)\)/g, (whole, target: string) => {
      // Already absolute, or a bare anchor into this same page.
      if (/^(https?:|mailto:|#|\/)/.test(target)) return whole

      const [path = '', hash] = target.split('#')
      const suffix = hash === undefined ? '' : `#${hash}`

      const page = SITE_PAGES[path]
      const to =
        page !== undefined
          ? `${page}${suffix}`
          : path.startsWith('assets/')
            ? `${RAW}/${path}${suffix}`
            : `${BLOB}/${path}${suffix}`

      rewritten.push({ from: target, to })
      return `](${to})`
    }),
  )

  return { title, body: body.trimStart(), rewritten }
}
