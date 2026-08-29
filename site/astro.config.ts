import starlight from '@astrojs/starlight'
import { defineConfig } from 'astro/config'
import { remarkBaseLinks } from './src/remark/base-links.ts'

/** Served under the repository name, because this is a project page. */
const BASE = '/transport-io'

export default defineConfig({
  // The default GitHub Pages URL for a project page, which is where this deploys. There is
  // no custom domain and no CNAME: a project page is served under a path, so `base` has to
  // match the repository name or every root-absolute link 404s.
  site: 'https://transport-io.github.io',
  base: BASE,
  markdown: { remarkPlugins: [[remarkBaseLinks, { base: BASE }]] },
  integrations: [
    starlight({
      title: 'transport-io',
      description:
        'Real-time apps over WebTransport. One connection, independent streams and unreliable datagrams, reliability chosen per message.',
      social: [
        {
          icon: 'github',
          label: 'GitHub',
          href: 'https://github.com/transport-io/transport-io',
        },
      ],
      editLink: { baseUrl: 'https://github.com/transport-io/transport-io/edit/main/site/' },
      customCss: ['./src/styles/site.css'],
      expressiveCode: {
        themes: ['github-dark', 'github-light'],
        styleOverrides: { borderRadius: '0.4rem', codeFontSize: '0.85rem' },
      },
      sidebar: [
        { label: 'Getting started', slug: 'getting-started' },
        {
          label: 'Guides',
          items: [
            { label: 'The two lanes', slug: 'guides/lanes' },
            { label: 'Rooms', slug: 'guides/rooms' },
            { label: 'call() and stream()', slug: 'guides/call-and-stream' },
            { label: 'Backpressure', slug: 'guides/backpressure' },
            { label: 'Reconnecting', slug: 'guides/reconnect' },
            { label: 'React', slug: 'guides/react' },
          ],
        },
        { label: 'Reference', slug: 'reference' },
        { label: 'Wire protocol', slug: 'protocol' },
        { label: 'Limitations', slug: 'limitations' },
      ],
    }),
  ],
})
