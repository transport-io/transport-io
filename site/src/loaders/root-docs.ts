/**
 * A content loader that reads the repository's own markdown, so `API.md` and `PROTOCOL.md`
 * stay single-copy and stay under `check-docs` and `check-norms`. See `transform.ts` for
 * what it adapts and why.
 */
import { readFileSync } from 'node:fs'
import { join, relative } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import type { Loader } from 'astro/loaders'
import { transformRootMarkdown } from './transform.ts'

export interface RootDoc {
  /** Path relative to the repository root. */
  readonly file: string
  /** The Starlight page id, which becomes the URL. */
  readonly id: string
  readonly description: string
  readonly order: number
}

export function rootDocs(docs: readonly RootDoc[]): Loader {
  return {
    name: 'transport-io-root-docs',
    async load({ store, parseData, renderMarkdown, generateDigest, watcher, config, logger }) {
      // No `store.clear()`. This runs after Starlight's own loader has populated the
      // collection, and clearing would delete the site's hand-written pages.
      const root = join(fileURLToPath(config.root), '..')

      for (const doc of docs) {
        const path = join(root, doc.file)
        const raw = readFileSync(path, 'utf8')
        const { title, body, rewritten } = transformRootMarkdown(raw, doc.file)

        const data = await parseData({
          id: doc.id,
          data: {
            title,
            description: doc.description,
            sidebar: { order: doc.order },
            editUrl: `https://github.com/transport-io/transport-io/edit/main/${doc.file}`,
          },
          filePath: path,
        })

        store.set({
          id: doc.id,
          data,
          body,
          // Relative to the Astro root, and these live above it: the store rejects an
          // absolute path outright. `../API.md` is what it wants and what dev-mode
          // change detection resolves against.
          filePath: relative(fileURLToPath(config.root), path),
          digest: generateDigest(raw),
          rendered: await renderMarkdown(body, { fileURL: pathToFileURL(path) }),
        })

        logger.info(`${doc.file} -> /${doc.id}/  (${rewritten.length} link(s) rewritten)`)
        watcher?.add(path)
      }
    },
  }
}
