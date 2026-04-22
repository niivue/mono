import { fileURLToPath } from 'node:url'
import { devImagesPlugin } from '@niivue/dev-images/vite-plugin'
import { defineConfig } from 'vite'

// When VITE_BASE is set (e.g. /mono/demo-ext-drawing/) rewrite absolute
// /volumes/ and /meshes/ paths inside bundled JS for GitHub Pages.
const ghBase = process.env.VITE_BASE ?? ''

function ghPagesRewritePlugin() {
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

export default defineConfig({
  base: ghBase || '/',
  plugins: [devImagesPlugin(), ghPagesRewritePlugin()],
  server: {
    port: 8082,
    headers: {
      'Cross-Origin-Opener-Policy': 'same-origin',
      'Cross-Origin-Embedder-Policy': 'require-corp',
    },
  },
  build: {
    outDir: 'dist',
    target: 'esnext',
    rollupOptions: {
      input: {
        drawing: fileURLToPath(new URL('drawing.html', import.meta.url)),
        magicWand: fileURLToPath(new URL('magic-wand.html', import.meta.url)),
      },
    },
  },
})
