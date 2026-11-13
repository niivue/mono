import { fileURLToPath } from 'node:url'
import { satteri } from '@astrojs/markdown-satteri'
import starlight from '@astrojs/starlight'
import { defineConfig } from 'astro/config'
import { checkLinks } from './src/lib/checkLinks'
import { packagesSection } from './src/lib/packageDocs'
import { fullSidebar } from './src/sidebar'
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
  // Docusaurus pages whose content moved under /packages/.
  redirects: {
    '/guide/react': `${base}packages/nv-react/`,
    '/guide/extensions': `${base}packages/`,
  },
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
      favicon: '/img/favicon.ico',
      // The icon is too small for Starlight's default large-image card.
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
      sidebar: fullSidebar(
        packagesSection(
          fileURLToPath(new URL('../../packages', import.meta.url)),
        ),
      ),
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
    {
      // The sidebar is built when the config loads, from src/sidebar.ts and
      // the pages in packages/*/docs. In dev, editing those two files, or
      // adding or removing a page, reloads the config.
      name: 'package-docs-reload',
      hooks: {
        'astro:config:setup': ({ addWatchFile }) => {
          addWatchFile(new URL('./src/sidebar.ts', import.meta.url))
          addWatchFile(new URL('./src/lib/packageDocs.ts', import.meta.url))
        },
        'astro:server:setup': ({ server }) => {
          const configFile = fileURLToPath(import.meta.url)
          const reload = (file: string) => {
            if (/[\\/]packages[\\/][^\\/]+[\\/]docs[\\/].*\.mdx?$/.test(file))
              server.watcher.emit('change', configFile)
          }
          server.watcher.on('add', reload)
          server.watcher.on('unlink', reload)
        },
      },
    },
  ],
  vite: {
    resolve: {
      // The guides live in packages/niivue/docs and import site components
      // (Demo) from here.
      alias: { '@site': fileURLToPath(new URL('./src', import.meta.url)) },
    },
  },
})
