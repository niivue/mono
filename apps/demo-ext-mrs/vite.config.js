import { devImagesPlugin } from '@niivue/dev-images/vite-plugin'
import { defineConfig } from 'vite'

// VITE_BASE: the app's own base path (e.g. /mono/demo-ext-mrs/)
// VITE_IMAGES_BASE: where shared dev-images live (e.g. /mono/)
const ghBase = process.env.VITE_BASE ?? ''
const imagesBase = process.env.VITE_IMAGES_BASE ?? ghBase

function ghPagesRewritePlugin() {
  if (!imagesBase) return null
  return {
    name: 'ghpages-rewrite-asset-urls',
    enforce: 'post',
    renderChunk(code) {
      let out = code
      // `signals` joins volumes/meshes so the demo's /signals/ data URLs
      // resolve under the shared images base on GitHub Pages.
      for (const dir of ['volumes', 'meshes', 'signals']) {
        out = out
          .replaceAll(`"/${dir}/`, `"${imagesBase}${dir}/`)
          .replaceAll(`'/${dir}/`, `'${imagesBase}${dir}/`)
          .replaceAll(`\`/${dir}/`, `\`${imagesBase}${dir}/`)
      }
      return out
    },
  }
}

export default defineConfig({
  base: ghBase || '/',
  plugins: [
    devImagesPlugin({ emit: !process.env.VITE_IMAGES_BASE }),
    ghPagesRewritePlugin(),
  ],
  server: {
    port: 8090,
  },
  build: {
    outDir: 'dist',
    target: 'esnext',
    rollupOptions: {
      input: 'mrsi.html',
    },
  },
})
