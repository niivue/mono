import { resolve } from 'node:path'
import { devImagesPlugin } from '@niivue/dev-images/vite-plugin'
import { defineConfig } from 'vite'

const ghBase = process.env.VITE_BASE ?? ''
const apiTarget = process.env.IIIF_SERVER_URL ?? 'http://localhost:8080'

export default defineConfig({
  base: ghBase || '/',
  plugins: [devImagesPlugin()],
  // Do NOT pre-bundle the local workspace build of niivue. Vite's optimizeDeps
  // caches a pre-bundled copy at dev-server start and does not invalidate it when
  // the package's dist/ is rebuilt, so editing niivue source + `nx build niivue`
  // would silently keep serving the OLD bundle until the cache is cleared. With
  // it excluded, Vite serves the current dist ESM directly and a page reload
  // picks up a fresh `nx build niivue`.
  optimizeDeps: { exclude: ['@niivue/niivue'] },
  server: {
    port: 8087,
    proxy: {
      '/api': apiTarget,
      '/iiif': apiTarget,
      '/volumes': apiTarget,
      '/vendor': apiTarget,
      '/dev': apiTarget,
    },
  },
  build: {
    outDir: 'dist',
    target: 'esnext',
    rollupOptions: {
      input: {
        index: resolve(__dirname, 'index.html'),
        sheet: resolve(__dirname, 'sheet.html'),
        osd: resolve(__dirname, 'osd-volume-desktop.html'),
        omezarr: resolve(__dirname, 'omezarr.html'),
        multiplanar: resolve(__dirname, 'multiplanar.html'),
        overlay: resolve(__dirname, 'overlay.html'),
        microscopy: resolve(__dirname, 'microscopy.html'),
        drawing: resolve(__dirname, 'drawing.html'),
        wsi: resolve(__dirname, 'wsi.html'),
      },
    },
  },
})
