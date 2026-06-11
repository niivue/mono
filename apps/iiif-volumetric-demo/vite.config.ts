import { resolve } from 'node:path'
import { devImagesPlugin } from '@niivue/dev-images/vite-plugin'
import { defineConfig } from 'vite'

const ghBase = process.env.VITE_BASE ?? ''
const apiTarget = process.env.IIIF_SERVER_URL ?? 'http://localhost:8080'

export default defineConfig({
  base: ghBase || '/',
  plugins: [devImagesPlugin()],
  server: {
    port: 8087,
    proxy: {
      '/api': apiTarget,
      '/iiif': apiTarget,
      '/volumes': apiTarget,
      '/zarr': apiTarget,
      '/dicom-wsi': apiTarget,
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
        range: resolve(__dirname, 'range.html'),
        tileRange: resolve(__dirname, 'tile-range.html'),
        multiplanar: resolve(__dirname, 'multiplanar.html'),
        overlay: resolve(__dirname, 'overlay.html'),
        microscopy: resolve(__dirname, 'microscopy.html'),
        drawing: resolve(__dirname, 'drawing.html'),
        wsi: resolve(__dirname, 'wsi.html'),
      },
    },
  },
})
