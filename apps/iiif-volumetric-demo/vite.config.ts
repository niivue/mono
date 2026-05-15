import { resolve } from 'node:path'
import { defineConfig } from 'vite'

const ghBase = process.env.VITE_BASE ?? ''
const apiTarget = process.env.IIIF_SERVER_URL ?? 'http://127.0.0.1:8080'

export default defineConfig({
  base: ghBase || '/',
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
        infinite: resolve(__dirname, 'infinite.html'),
        'neuro-desktop': resolve(__dirname, 'neuro-desktop.html'),
        openneuro: resolve(__dirname, 'openneuro.html'),
        'osd-volume-desktop': resolve(__dirname, 'osd-volume-desktop.html'),
        'volume-fly-space': resolve(__dirname, 'volume-fly-space.html'),
      },
    },
  },
})
