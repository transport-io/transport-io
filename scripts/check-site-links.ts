/**
 * Every internal link in the built site must resolve.
 *
 * The site deploys as a GitHub Pages *project* page, served under `/transport-io/`. A
 * markdown link written `](/limitations/)` is emitted verbatim by Astro: correct in
 * `astro dev` at the root, and a 404 in production. Local success is not evidence here,
 * which is exactly the class of defect this repository keeps finding, so the assertion runs
 * against `dist` rather than against intent.
 *
 * Two properties, and a floor under each so neither can pass over an empty set:
 *
 *   1. every root-absolute href carries the base path;
 *   2. every root-absolute href points at a file that exists in `dist`.
 *
 * The floors are not decoration. The first draft of the sibling check in
 * `site/src/loaders/transform.test.ts` asserted that no relative link survived and passed
 * over two files that had no relative links at all. It was green and meaningless. Any
 * assertion of the form "nothing bad survives" needs a companion proving there was
 * something to survive.
 *
 *   bun run scripts/check-site-links.ts
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { join, resolve } from 'node:path'

const DIST = resolve(import.meta.dirname, '../site/dist')
const BASE = '/transport-io'

/** Pages the site is expected to have. Fewer than this and the build produced a stub. */
const MIN_PAGES = 8
/** Internal links across the whole site. Fewer than this and the check saw nothing. */
const MIN_INTERNAL_LINKS = 40

if (!existsSync(DIST)) {
  console.error(`no build at ${DIST}. Run: npm -w site run build`)
  process.exit(1)
}

function htmlFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = join(dir, e.name)
    if (e.isDirectory()) return htmlFiles(p)
    return e.name.endsWith('.html') ? [p] : []
  })
}

/** Does a root-absolute href correspond to something on disk? */
function resolves(href: string): boolean {
  const path = href.split(/[?#]/)[0] ?? ''
  const rel = path.slice(BASE.length).replace(/^\//, '')
  for (const candidate of [rel, join(rel, 'index.html'), `${rel}.html`]) {
    const full = join(DIST, candidate)
    if (existsSync(full) && statSync(full).isFile()) return true
  }
  // A directory URL that Astro emitted as `dir/index.html`.
  return existsSync(join(DIST, rel, 'index.html'))
}

const pages = htmlFiles(DIST)
const problems: string[] = []
let internal = 0

for (const page of pages) {
  const html = readFileSync(page, 'utf8')
  const where = page.slice(DIST.length + 1)

  for (const m of html.matchAll(/(?:href|src)="(\/[^"]*)"/g)) {
    const href = m[1] as string
    if (href.startsWith('//')) continue // protocol-relative, an external link
    internal++

    if (!href.startsWith(`${BASE}/`) && href !== BASE) {
      problems.push(
        `${where}: "${href}" is root-absolute but missing the base path.\n` +
          `    It resolves in dev at the root and 404s at ${BASE}${href}.`,
      )
      continue
    }
    if (!resolves(href)) {
      problems.push(`${where}: "${href}" points at nothing in the build.`)
    }
  }
}

if (pages.length < MIN_PAGES) {
  problems.push(
    `only ${pages.length} page(s) built, expected at least ${MIN_PAGES}. ` +
      'A link check over a near-empty site agrees with everything.',
  )
}
if (internal < MIN_INTERNAL_LINKS) {
  problems.push(
    `only ${internal} internal link(s) found, expected at least ${MIN_INTERNAL_LINKS}. ` +
      'Nothing bad survived because nothing was there.',
  )
}

for (const p of problems.slice(0, 20)) console.error(`\n${p}`)
if (problems.length > 20) console.error(`\n... and ${problems.length - 20} more`)
if (problems.length > 0) {
  console.error(`\n${problems.length} problem(s).`)
  process.exit(1)
}
console.log(
  `site links: ${internal} internal link(s) across ${pages.length} page(s), all based and all resolving`,
)
