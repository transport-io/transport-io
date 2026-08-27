import starlight from '@astrojs/starlight'
import { defineConfig } from 'astro/config'

export default defineConfig({
  site: 'https://transport-io.js.org',
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
          ],
        },
        { label: 'Reference', slug: 'reference' },
        { label: 'Wire protocol', slug: 'protocol' },
        { label: 'Limitations', slug: 'limitations' },
      ],
    }),
  ],
})
