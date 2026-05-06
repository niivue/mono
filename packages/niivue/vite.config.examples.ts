import { readdirSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath, URL } from 'node:url'
import { devImagesPlugin } from '@niivue/dev-images/vite-plugin'
import type { Plugin } from 'vite'
import { defineConfig } from 'vite'

const root = fileURLToPath(new URL('.', import.meta.url))
const examplesDir = resolve(root, 'examples')

// Auto-discover all .html files in examples/
const htmlFiles = readdirSync(examplesDir).filter((f) => f.endsWith('.html'))
const input = Object.fromEntries(
  htmlFiles.map((f) => [f.replace('.html', ''), resolve(examplesDir, f)]),
)

// When VITE_BASE is set (e.g. /mono/) rewrite absolute /volumes/ and /meshes/
// paths inside bundled JS so they resolve correctly on GitHub Pages.
const ghBase = process.env.VITE_BASE ?? ''

function ghPagesRewritePlugin(): Plugin | null {
  if (!ghBase) return null
  return {
    name: 'ghpages-rewrite-asset-urls',
    enforce: 'post',
    renderChunk(code) {
      let out = code
      for (const dir of ['volumes', 'meshes']) {
        out = out
          .replaceAll(`"/${dir}/`, `"${ghBase}${dir}/`)
          .replaceAll(`'/${dir}/`, `'${ghBase}${dir}/`)
          .replaceAll(`\`/${dir}/`, `\`${ghBase}${dir}/`)
      }
      return out
    },
  }
}

const PERF_BUILD = process.env.NIIVUE_PERF === '1'

export default defineConfig({
  base: ghBase || '/',
  define: {
    __NIIVUE_PERF__: JSON.stringify(PERF_BUILD),
  },
  plugins: [devImagesPlugin(), ghPagesRewritePlugin()],
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    rollupOptions: {
      input,
    },
  },
})
