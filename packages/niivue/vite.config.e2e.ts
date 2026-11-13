import {
  createReadStream,
  existsSync,
  globSync,
  readdirSync,
  readFileSync,
} from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath, URL } from 'node:url'
import { devImagesPlugin } from '@niivue/dev-images/vite-plugin'
import type { Plugin } from 'vite'
import { defineConfig, mergeConfig } from 'vite'
import examples from './vite.config.examples'

// A built copy of the examples site for the e2e suite (`bun run e2e:serve:bundle`).
// The dev server sends ~380 unbundled modules to every test's fresh page, which
// is most of a test's time on a slow runner. Specs also import source by URL
// (`import('/src/index.ts')`), so each such module is built as its own entry at
// `src/<path>.js`, sharing chunks (and so module state) with the pages.
// The preview server runs on Node, not Bun: Bun's HTTP server died with
// "write after end" when a page aborted a streamed response, failing every
// later test. `--configLoader runner` lets Node load the TypeScript plugins.

const root = fileURLToPath(new URL('.', import.meta.url))
const repoRoot = resolve(root, '../..')

const specSources = readdirSync(resolve(root, 'e2e'))
  // Helpers (renderHarness.ts) import /src modules too, not only specs.
  .filter((f) => f.endsWith('.ts'))
  .flatMap((f) =>
    [
      ...readFileSync(resolve(root, 'e2e', f), 'utf8').matchAll(
        /\/src\/([\w./${}-]+)\.ts/g,
      ),
    ].map((m) => m[1].replace(/\$\{[^}]*\}/g, '*')),
  )
const srcEntries = Object.fromEntries(
  globSync(
    [...new Set(specSources)].map((p) => `src/${p}.ts`),
    {
      cwd: root,
    },
  ).map((f) => [f.slice(0, -3), resolve(root, f)]),
)

// Map the dev server's URLs that specs use onto the build.
function e2ePreviewPlugin(): Plugin {
  return {
    name: 'e2e-preview-urls',
    configurePreviewServer(server) {
      server.middlewares.use((req, res, next) => {
        const path = (req.url ?? '').split('?')[0]
        if (path.startsWith('/src/') && path.endsWith('.ts')) {
          req.url = `${path.slice(0, -3)}.js`
          return next()
        }
        // Raw files by path: source assets (matcap images) and, via /@fs/,
        // the uikit bundle the uikit specs import.
        const file = path.startsWith('/src/')
          ? resolve(root, path.slice(1))
          : path.startsWith('/@fs/')
            ? resolve(path.slice(4))
            : ''
        if (!file.startsWith(`${repoRoot}/`) || !existsSync(file)) return next()
        if (file.endsWith('.js')) {
          // The uikit bundle keeps @niivue/niivue external; the dev server
          // rewrites that bare import, preview serves files raw. Point it at
          // the built src/index entry so it shares module state with the specs.
          res.setHeader('Content-Type', 'text/javascript')
          return res.end(
            readFileSync(file, 'utf8').replaceAll(
              '"@niivue/niivue"',
              '"/src/index.js"',
            ),
          )
        }
        createReadStream(file).pipe(res)
      })
    },
  }
}

export default mergeConfig(
  { ...examples, plugins: [] },
  defineConfig({
    // Images are served from dev-images, not copied (~100 MB).
    plugins: [devImagesPlugin({ emit: false }), e2ePreviewPlugin()],
    build: {
      outDir: 'dist-e2e',
      minify: false,
      // E2E_COVERAGE=1 maps browser coverage back to src/ (e2e/coverage.ts).
      sourcemap: process.env.E2E_COVERAGE === '1',
      rolldownOptions: {
        // Vite drops entry exports in app builds; the specs import them.
        preserveEntrySignatures: 'exports-only',
        input: { ...examples.build?.rolldownOptions?.input, ...srcEntries },
        output: {
          entryFileNames: (chunk) =>
            chunk.name.startsWith('src/')
              ? '[name].js'
              : 'assets/[name]-[hash].js',
        },
      },
    },
    preview: { port: 5273, strictPort: true },
  }),
)
