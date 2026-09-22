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

// When VITE_BASE is set (e.g. /mono/) rewrite absolute /volumes/, /meshes/ and
// /signals/ paths inside bundled JS so they resolve correctly on GitHub Pages.
const ghBase = process.env.VITE_BASE ?? ''

function ghPagesRewritePlugin(): Plugin | null {
  if (!ghBase) return null
  return {
    name: 'ghpages-rewrite-asset-urls',
    enforce: 'post',
    renderChunk(code) {
      let out = code
      for (const dir of ['volumes', 'meshes', 'signals']) {
        out = out
          .replaceAll(`"/${dir}/`, `"${ghBase}${dir}/`)
          .replaceAll(`'/${dir}/`, `'${ghBase}${dir}/`)
          .replaceAll(`\`/${dir}/`, `\`${ghBase}${dir}/`)
      }
      return out
    },
  }
}

export default defineConfig({
  base: ghBase || '/',
  plugins: [devImagesPlugin(), ghPagesRewritePlugin()],
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
  // One input per examples/*.html, so this is a code-splitting build. Vite's
  // default worker.format of 'iife' is rejected outright by Rollup in that
  // mode, and any worker reached from an example (the OME-Zarr chunk pool)
  // fails the whole build. The library build does not hit this because it is a
  // single-entry lib build.
  worker: {
    format: 'es',
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    rollupOptions: {
      input,
    },
  },
})
