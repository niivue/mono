import { fileURLToPath } from 'node:url'
import { devImagesPlugin } from '@niivue/dev-images/vite-plugin'
import { defineConfig } from 'vite'

// VITE_BASE: the app's own base path (e.g. /mono/demo-uikit/)
// VITE_IMAGES_BASE: where shared dev-images live (e.g. /mono/)
const ghBase = process.env.VITE_BASE ?? ''
const imagesBase = process.env.VITE_IMAGES_BASE ?? ghBase

const PAGES = [
  'index',
  'buttons',
  'volume',
  'subvolume',
  'slide',
  'slide-wsi',
  'standalone',
]

function ghPagesRewritePlugin() {
  if (!imagesBase) return null
  return {
    name: 'ghpages-rewrite-asset-urls',
    enforce: 'post',
    renderChunk(code) {
      let out = code
      for (const dir of ['volumes', 'meshes'])
        for (const q of ['"', "'", '`'])
          out = out.replaceAll(`${q}/${dir}/`, `${q}${imagesBase}${dir}/`)
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
  server: { port: 8093 },
  build: {
    outDir: 'dist',
    target: 'esnext',
    rolldownOptions: {
      input: Object.fromEntries(
        PAGES.map((p) => [
          p,
          fileURLToPath(new URL(`${p}.html`, import.meta.url)),
        ]),
      ),
    },
  },
})
