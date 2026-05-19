import { resolve } from 'node:path'
import { devImagesPlugin } from '@niivue/dev-images/vite-plugin'
import { defineConfig } from 'vite'

const ghBase = process.env.VITE_BASE ?? ''
const apiTarget = process.env.IIIF_SERVER_URL ?? 'http://127.0.0.1:8080'

export default defineConfig({
  base: ghBase || '/',
  plugins: [devImagesPlugin()],
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
        stitch: resolve(__dirname, 'stitch.html'),
        osd: resolve(__dirname, 'osd-volume-desktop.html'),
        fly: resolve(__dirname, 'volume-fly-space.html'),
        omezarr: resolve(__dirname, 'omezarr.html'),
      },
    },
  },
})
