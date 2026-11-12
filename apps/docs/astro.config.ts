import { satteri } from '@astrojs/markdown-satteri'
import starlight from '@astrojs/starlight'
import { defineConfig } from 'astro/config'
import { checkLinks } from './src/lib/checkLinks'
import { sidebar } from './src/sidebar'
import { repoUrl } from './src/site'

// The site is served from the root in dev and from /mono/docs/ on GitHub
// Pages; build-pages.sh passes DOCS_BASE_URL. With trailingSlash 'always'
// Astro's BASE_URL ends in a slash, so this one does too.
const base = (process.env.DOCS_BASE_URL ?? '/').replace(/\/?$/, '/')
const site = 'https://niivue.github.io'

export default defineConfig({
  site,
  base,
  trailingSlash: 'always',
  markdown: {
    processor: satteri({
      hastPlugins: [
        // Astro leaves Markdown links alone; root-relative ones such as
        // `/gallery/sync/` need the base to work under /mono/docs/.
        {
          name: 'base-links',
          element: {
            filter: ['a'],
            visit(node, ctx) {
              const href = node.properties.href
              if (typeof href === 'string' && /^\/(?!\/)/.test(href)) {
                ctx.setProperty(node, 'href', base + href.slice(1))
              }
            },
          },
        },
      ],
    }),
  },
  integrations: [
    starlight({
      title: 'NiiVue',
      description: 'WebGPU and WebGL2 medical image viewer',
      logo: { src: './src/assets/niivue-icon.png' },
      favicon: '/img/favicon.ico',
      // The logo is too small for Starlight's default large-image card.
      head: [
        {
          tag: 'meta',
          attrs: {
            property: 'og:image',
            content: `${site}${base}img/niivue-icon.png`,
          },
        },
        { tag: 'meta', attrs: { name: 'twitter:card', content: 'summary' } },
      ],
      social: [{ icon: 'github', label: 'GitHub', href: repoUrl }],
      editLink: { baseUrl: `${repoUrl}/edit/main/apps/docs/` },
      sidebar,
      routeMiddleware: './src/routeData.ts',
      components: {
        Hero: './src/components/Hero.astro',
        PageTitle: './src/components/PageTitle.astro',
        SiteTitle: './src/components/SiteTitle.astro',
      },
      customCss: ['./src/styles/custom.css'],
      expressiveCode: {
        themes: ['min-dark', 'min-light'],
        useStarlightUiThemeColors: true,
        styleOverrides: {
          borderRadius: '6px',
          frames: { shadowColor: 'transparent' },
        },
      },
    }),
    checkLinks(base),
  ],
})
