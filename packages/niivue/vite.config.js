import { createReadStream, existsSync, readFileSync, statSync } from 'node:fs'
import { extname, resolve } from 'node:path'
import { fileURLToPath, URL } from 'node:url'
import { devImagesPlugin } from '@niivue/dev-images/vite-plugin'
import { defineConfig } from 'vite'

const root = fileURLToPath(new URL('.', import.meta.url))
const repoRoot = resolve(root, '../..')
const src = (path) => resolve(root, 'src', path)

// The demo apps .github/build-pages.sh publishes beside the examples.
const SITE_APPS = [
  'dandi-demo',
  'demo-nv-web-component',
  'demo-ext-drawing',
  'demo-ext-image-processing',
  'demo-ext-save-html',
  'demo-ext-dcm2niix',
  'demo-ext-niimath',
  'demo-ext-tile',
]

// Lay the dev server out like the GitHub Pages site, so the landing page and
// the gallery's links to the demo apps work locally: `/` serves the landing
// page and `/<app>/...` serves apps/<app> (its html with module scripts mapped
// to the app's own files, its public/ files, and its sources). Each app also
// keeps its own dev server: `bunx nx dev <app>`.
function pagesSiteDevPlugin() {
  return {
    name: 'pages-site-dev',
    configureServer(server) {
      server.middlewares.use(async (req, res, next) => {
        const [path, query = ''] = (req.url ?? '').split('?')
        if (path === '/' || path === '/index.html') {
          const html = readFileSync(
            resolve(repoRoot, '.github/pages/index.html'),
            'utf8',
          )
          res.setHeader('Content-Type', 'text/html')
          res.end(await server.transformIndexHtml('/index.html', html))
          return
        }
        // The docs site is an Astro app, which this server cannot run: say so
        // rather than 404.
        if (path === '/docs' || path.startsWith('/docs/')) {
          res.setHeader('Content-Type', 'text/html')
          res.end(
            '<!doctype html><meta charset="utf-8"><title>Docs</title>' +
              '<body style="font:16px system-ui;padding:2em;max-width:40em">' +
              '<h1>Docs are not served by this dev server</h1>' +
              '<p>The published site builds them from <code>apps/docs</code>. ' +
              'Run <code>bunx nx dev docs-site</code> for a live copy, or ' +
              '<code>.github/build-pages.sh --serve</code> for the whole ' +
              'published site, or read them at ' +
              '<a href="https://niivue.github.io/mono/docs/">niivue.github.io/mono/docs</a>.</p>',
          )
          return
        }
        const [, app, ...rest] = path.split('/')
        // An app fetches its public files from BASE_URL: its own folder when
        // published, '/' here (e.g. demo-ext-save-html's niivue-standalone.js).
        if (rest.length === 0 && app && !existsSync(resolve(root, app))) {
          for (const name of SITE_APPS) {
            const file = resolve(repoRoot, 'apps', name, 'public', app)
            if (existsSync(file)) {
              req.url = `/@fs${file}`
              return next()
            }
          }
        }
        if (!SITE_APPS.includes(app)) return next()
        const appDir = resolve(repoRoot, 'apps', app)
        const file = rest.join('/') || 'index.html'
        if (file.endsWith('.html')) {
          const source = resolve(appDir, file)
          // Stay inside the app's folder ("/<app>/../x.html").
          if (!source.startsWith(`${appDir}/`) || !existsSync(source))
            return next()
          // Module scripts, absolute ("/src/x") or relative ("src/x"), load
          // from the app's own folder.
          const html = readFileSync(source, 'utf8').replace(
            /(<script[^>]*\ssrc=")\/?(?!\/|https?:)([^"]+)"/g,
            `$1/@fs${appDir}/$2"`,
          )
          res.setHeader('Content-Type', 'text/html')
          res.end(await server.transformIndexHtml(path, html))
          return
        }
        const fromPublic = resolve(appDir, 'public', file)
        const target = existsSync(fromPublic)
          ? fromPublic
          : resolve(appDir, file)
        // A missing file is a 404, not the SPA fallback: zarr readers probe
        // for metadata files a store may not have. So is a folder, or a path
        // that climbs out of the app ("/<app>/../x").
        const isFile = statSync(target, { throwIfNoEntry: false })?.isFile()
        if (!isFile || !target.startsWith(`${appDir}/`)) {
          res.statusCode = 404
          res.end()
          return
        }
        // Vite would transform an extensionless file (zarr metadata, chunks)
        // as a JS module; send its bytes.
        if (!extname(target)) {
          res.setHeader('Content-Type', 'application/octet-stream')
          createReadStream(target).pipe(res)
          return
        }
        req.url = `/@fs${target}${query ? `?${query}` : ''}`
        next()
      })
    },
  }
}

export default defineConfig({
  plugins: [devImagesPlugin(), pagesSiteDevPlugin()],
  resolve: {
    // The demo apps and the packages they use import @niivue/niivue by name;
    // send them to the source, as the examples are, so dev never runs a stale
    // dist build.
    alias: [
      { find: '@', replacement: src('') },
      { find: /^@niivue\/niivue$/, replacement: src('index.ts') },
      {
        find: /^@niivue\/niivue\/webgpu$/,
        replacement: src('index.webgpu.ts'),
      },
      {
        find: /^@niivue\/niivue\/webgl2$/,
        replacement: src('index.webgl2.ts'),
      },
      {
        find: /^@niivue\/niivue\/viewport$/,
        replacement: src('control/NVCanvasViewportController.ts'),
      },
      {
        find: /^@niivue\/niivue\/scene$/,
        replacement: src('scene/NvSceneController.ts'),
      },
      {
        find: /^@niivue\/niivue\/assets\/(fonts|matcaps)$/,
        replacement: src('assets/$1/index.ts'),
      },
    ],
  },
  // As the niimath and dcm2niix demo apps do: their WASM workers break when
  // prebundled.
  optimizeDeps: {
    exclude: ['@niivue/niimath', '@niivue/nv-ext-niimath', '@niivue/dcm2niix'],
  },
  server: {
    port: 8080,
  },
})
