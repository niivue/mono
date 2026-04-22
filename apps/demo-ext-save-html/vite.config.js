import { devImagesPlugin } from '@niivue/dev-images/vite-plugin'
import { defineConfig } from 'vite'

// VITE_BASE: the app's own base path (e.g. /mono/demo-ext-save-html/)
// VITE_IMAGES_BASE: where shared dev-images live (e.g. /mono/)
// When VITE_IMAGES_BASE is set, images are not emitted into this app's
// build output — they are served from the shared root instead.
const ghBase = process.env.VITE_BASE ?? ''
const imagesBase = process.env.VITE_IMAGES_BASE ?? ghBase

function ghPagesRewritePlugin() {
  if (!imagesBase) return null
  return {
    name: 'ghpages-rewrite-asset-urls',
    enforce: 'post',
    renderChunk(code) {
      let out = code
      for (const dir of ['volumes', 'meshes']) {
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
