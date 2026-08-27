import { defineCollection } from 'astro:content'
import { docsLoader } from '@astrojs/starlight/loaders'
import { docsSchema } from '@astrojs/starlight/schema'
import type { Loader } from 'astro/loaders'
import { rootDocs } from './loaders/root-docs.ts'

/**
 * One collection, two sources. Starlight routes pages from `docs` and nothing else, so the
 * repository's own markdown has to arrive in the same collection rather than beside it.
 *
 * Order matters: Starlight's loader clears the store and loads `src/content/docs`, then the
 * root documents are appended. Reversing it would delete them.
 */
function combined(...loaders: readonly Loader[]): Loader {
  return {
    name: 'transport-io-docs',
    async load(context) {
      for (const loader of loaders) await loader.load(context)
    },
  }
}

export const collections = {
  docs: defineCollection({
    loader: combined(
      docsLoader(),
      rootDocs([
        {
          file: 'API.md',
          id: 'reference',
          description: 'The TypeScript surface, rendered from the gated source document.',
          order: 1,
        },
        {
          file: 'PROTOCOL.md',
          id: 'protocol',
          description:
            'The wire format, written to be implementable without reading the source.',
          order: 2,
        },
        {
          file: 'KNOWN-ISSUES.md',
          id: 'limitations',
          description: 'What this library refuses to do, and the one measured defect.',
          order: 3,
        },
      ]),
    ),
    schema: docsSchema(),
  }),
}
