/**
 * Prefix root-absolute markdown links with the site's base path.
 *
 * This deploys as a GitHub Pages *project* page, so everything is served under
 * `/transport-io/`. A link written `](/limitations/)` in markdown is emitted verbatim by
 * Astro: it works perfectly in `astro dev` at the root and 404s in production. That is the
 * worst shape of bug available, because the place it breaks is the only place it matters.
 *
 * Rather than prefixing by hand in every document and trusting nobody forgets, links are
 * rewritten here, and the built output is then asserted by `scripts/check-site-links.ts`,
 * which is the check that actually holds the property.
 */

interface Node {
  type: string
  url?: string
  children?: Node[]
}

/** Exported for the test: walks an mdast tree and prefixes what needs prefixing. */
export function prefixRootLinks(tree: Node, base: string): number {
  const clean = base.replace(/\/$/, '')
  if (clean === '') return 0
  let changed = 0

  const walk = (node: Node): void => {
    if ((node.type === 'link' || node.type === 'definition') && typeof node.url === 'string') {
      // Root-absolute only. Protocol-relative `//host` is an external link wearing a
      // similar shape and must not be touched.
      const url = node.url
      if (url.startsWith('/') && !url.startsWith('//') && !url.startsWith(`${clean}/`)) {
        node.url = `${clean}${url}`
        changed++
      }
    }
    for (const child of node.children ?? []) walk(child)
  }

  walk(tree)
  return changed
}

export function remarkBaseLinks({ base }: { base: string }): (tree: Node) => void {
  return (tree: Node): void => {
    prefixRootLinks(tree, base)
  }
}
