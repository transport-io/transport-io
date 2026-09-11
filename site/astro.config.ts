import starlight from '@astrojs/starlight'
import { defineConfig } from 'astro/config'
import { remarkBaseLinks } from './src/remark/base-links.ts'

/** Served under the repository name, because this is a project page. */
const BASE = '/transport-io'

/**
 * A block tagged `file=name`, which is what the docs gates assemble into a file of that
 * name, shows the name as its label. The name is written once, in the tag.
 */
const fileAsTitle = {
  name: 'file-as-title',
  hooks: {
    preprocessMetadata: ({
      codeBlock,
    }: {
      codeBlock: { meta: string; props: { title?: string | undefined } }
    }) => {
      const m = /(?:^|\s)file=([\w./-]+)/.exec(codeBlock.meta)
      if (m?.[1] !== undefined && codeBlock.props.title === undefined) {
        codeBlock.props.title = m[1]
      }
    },
  },
}

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
      // The landing page has its own first screen, and the header sets the wordmark as live
      // text in the code face, which an image of the lockup cannot do.
      components: {
        Hero: './src/components/Hero.astro',
        SiteTitle: './src/components/SiteTitle.astro',
      },
      /**
       * Code is the strongest element on every page. The block is a panel one step lighter
       * than the ground with a hairline around it and a dim label where a file name goes:
       * no tabs, no titlebar dots, no shadow, no rounding. Each theme gets its own colours
       * from the brand notes rather than one derived from the other.
       */
      expressiveCode: {
        plugins: [fileAsTitle],
        themes: ['vitesse-dark', 'vitesse-light'],
        styleOverrides: {
          borderRadius: '0',
          borderWidth: '1px',
          borderColor: ({ theme }) => (theme.type === 'dark' ? '#33302a' : '#cfc9bb'),
          codeBackground: ({ theme }) => (theme.type === 'dark' ? '#1d1a16' : '#f3f1ea'),
          codeFontFamily:
            "'IBM Plex Mono', ui-monospace, SFMono-Regular, Menlo, Consolas, monospace",
          codeFontSize: '0.9375rem',
          codeLineHeight: '1.6',
          codePaddingInline: '1.25rem',
          codePaddingBlock: '1rem',
          uiFontFamily:
            "'IBM Plex Mono', ui-monospace, SFMono-Regular, Menlo, Consolas, monospace",
          uiFontSize: '0.875rem',
          focusBorder: ({ theme }) => (theme.type === 'dark' ? '#d9692c' : '#c2551d'),
          frames: {
            shadowColor: 'transparent',
            frameBoxShadowCssValue: 'none',
            editorTabBorderRadius: '0',
            editorTabBarBackground: ({ theme }) =>
              theme.type === 'dark' ? '#1d1a16' : '#f3f1ea',
            editorTabBarBorderColor: 'transparent',
            editorTabBarBorderBottomColor: ({ theme }) =>
              theme.type === 'dark' ? '#33302a' : '#cfc9bb',
            editorActiveTabBackground: ({ theme }) =>
              theme.type === 'dark' ? '#1d1a16' : '#f3f1ea',
            editorActiveTabForeground: ({ theme }) =>
              theme.type === 'dark' ? '#9c9588' : '#6b655b',
            editorActiveTabIndicatorTopColor: 'transparent',
            editorActiveTabIndicatorBottomColor: 'transparent',
            editorBackground: ({ theme }) => (theme.type === 'dark' ? '#1d1a16' : '#f3f1ea'),
            terminalBackground: ({ theme }) => (theme.type === 'dark' ? '#1d1a16' : '#f3f1ea'),
            terminalTitlebarBackground: ({ theme }) =>
              theme.type === 'dark' ? '#1d1a16' : '#f3f1ea',
            terminalTitlebarForeground: ({ theme }) =>
              theme.type === 'dark' ? '#9c9588' : '#6b655b',
            terminalTitlebarBorderBottomColor: ({ theme }) =>
              theme.type === 'dark' ? '#33302a' : '#cfc9bb',
            terminalTitlebarDotsForeground: 'transparent',
            terminalTitlebarDotsOpacity: '0',
            inlineButtonBackground: ({ theme }) =>
              theme.type === 'dark' ? '#1d1a16' : '#f3f1ea',
            inlineButtonBorder: ({ theme }) => (theme.type === 'dark' ? '#33302a' : '#cfc9bb'),
            inlineButtonForeground: ({ theme }) =>
              theme.type === 'dark' ? '#9c9588' : '#6b655b',
          },
        },
      },
      sidebar: [
        { label: 'Getting started', slug: 'getting-started' },
        { label: 'Tutorial', slug: 'tutorial/chat' },
        {
          label: 'Guides',
          items: [
            { label: 'The two lanes', slug: 'guides/lanes' },
            { label: 'Types, or a schema', slug: 'guides/schema' },
            { label: 'Rooms', slug: 'guides/rooms' },
            { label: 'call() and stream()', slug: 'guides/call-and-stream' },
            { label: 'Backpressure', slug: 'guides/backpressure' },
            { label: 'Reconnecting', slug: 'guides/reconnect' },
            { label: 'Certificates', slug: 'guides/certificates' },
            { label: 'The fallback', slug: 'guides/fallback' },
            { label: 'React', slug: 'guides/react' },
            { label: 'Registering the map', slug: 'guides/register' },
          ],
        },
        { label: 'Examples', slug: 'examples' },
        { label: 'Troubleshooting', slug: 'troubleshooting' },
        { label: 'Reference', slug: 'reference' },
        { label: 'Wire protocol', slug: 'protocol' },
        { label: 'Limitations', slug: 'limitations' },
      ],
    }),
  ],
})
