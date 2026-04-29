import { defineConfig } from 'vite'

// VITE_BASE: the app's own base path on GitHub Pages (e.g. /mono/demo-ext-dcm2niix/)
const ghBase = process.env.VITE_BASE ?? ''

export default defineConfig({
  base: ghBase || '/',
  server: {
    port: 8086,
  },
  // dcm2niix's worker uses dynamic-import resolution that
  // chokes when prebundled. Defer it to runtime.
  optimizeDeps: {
    exclude: ['@niivue/dcm2niix'],
  },
  build: {
    outDir: 'dist',
    target: 'esnext',
    rollupOptions: {
      input: 'index.html',
    },
  },
})
