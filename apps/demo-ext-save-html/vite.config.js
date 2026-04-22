import { devImagesPlugin } from '@niivue/dev-images/vite-plugin'
import { defineConfig } from 'vite'

// When VITE_BASE is set (e.g. /mono/demo-ext-save-html/) rewrite absolute
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
    port: 8085,
  },
  build: {
    outDir: 'dist',
    target: 'esnext',
    rollupOptions: {
      input: 'index.html',
    },
  },
})
