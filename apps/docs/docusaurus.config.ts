import type * as Preset from '@docusaurus/preset-classic'
import type { Config } from '@docusaurus/types'
import { themes as prismThemes } from 'prism-react-renderer'

// The site is served from the pages root in dev and from /mono/docs/ on
// GitHub Pages; build-pages.sh passes DOCS_BASE_URL.
const baseUrl = process.env.DOCS_BASE_URL ?? '/'

// Demos load their images, and the gallery embeds the example pages, from
// the published examples site. Point this at a local `bun run dev` server in packages/niivue
// (http://localhost:5273/) to try unpublished examples.
const examplesBase =
  process.env.DOCS_EXAMPLES_BASE ?? 'https://niivue.github.io/mono/'

const repoUrl = 'https://github.com/niivue/mono'

const config: Config = {
  title: 'NiiVue',
  tagline: 'WebGPU and WebGL2 medical image viewer',
  favicon: 'img/favicon.ico',
  url: 'https://niivue.github.io',
  baseUrl,
  organizationName: 'niivue',
  projectName: 'mono',
  trailingSlash: false,
  onBrokenLinks: 'throw',
  markdown: {
    hooks: { onBrokenMarkdownLinks: 'throw' },
  },
  i18n: { defaultLocale: 'en', locales: ['en'] },
  customFields: { examplesBase, repoUrl },
  stylesheets: [
    {
      href: 'https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&family=JetBrains+Mono:wght@400;500&family=Space+Grotesk:wght@500;600;700&display=swap',
      type: 'text/css',
    },
  ],
  headTags: [
    {
      tagName: 'link',
      attributes: { rel: 'preconnect', href: 'https://fonts.gstatic.com' },
    },
  ],
  plugins: [
    './plugins/niivue-webpack-plugin.ts',
    './plugins/gallery-plugin.ts',
  ],
  presets: [
    [
      'classic',
      {
        docs: {
          routeBasePath: 'guide',
          sidebarPath: './sidebars.ts',
          editUrl: `${repoUrl}/edit/main/apps/docs/`,
        },
        blog: false,
        theme: { customCss: './src/css/custom.css' },
      } satisfies Preset.Options,
    ],
  ],
  themeConfig: {
    colorMode: { defaultMode: 'dark', respectPrefersColorScheme: true },
    image: 'img/niivue-icon.png',
    navbar: {
      title: 'NiiVue',
      logo: { alt: 'NiiVue', src: 'img/niivue-icon.png' },
      items: [
        {
          type: 'docSidebar',
          sidebarId: 'docs',
          position: 'left',
          label: 'Documentation',
        },
        { to: '/gallery', label: 'Gallery', position: 'left' },
        {
          href: repoUrl,
          position: 'right',
          className: 'header-github-link',
          'aria-label': 'GitHub repository',
        },
      ],
    },
    footer: {
      style: 'dark',
      links: [
        {
          title: 'Docs',
          items: [
            { label: 'Getting started', to: '/guide' },
            { label: 'Loading images', to: '/guide/loading' },
            { label: 'React', to: '/guide/react' },
            { label: 'Gallery', to: '/gallery' },
          ],
        },
        {
          title: 'Packages',
          items: [
            {
              label: '@niivue/niivue',
              href: 'https://www.npmjs.com/package/@niivue/niivue',
            },
            {
              label: '@niivue/nvreact',
              href: 'https://www.npmjs.com/package/@niivue/nvreact',
            },
          ],
        },
        {
          title: 'Code',
          items: [
            { label: 'niivue/mono', href: repoUrl },
            { label: 'Examples', href: examplesBase },
            { label: 'Issues', href: `${repoUrl}/issues` },
          ],
        },
      ],
      copyright: `NiiVue contributors. BSD-2-Clause.`,
    },
    prism: {
      theme: prismThemes.github,
      darkTheme: prismThemes.nightOwl,
    },
  } satisfies Preset.ThemeConfig,
}

export default config
