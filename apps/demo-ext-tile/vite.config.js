import { defineConfig } from 'vite'

// VITE_BASE: the app's own base path (e.g. /mono/demo-ext-tile/)
export default defineConfig({
  base: process.env.VITE_BASE || '/',
  server: { port: 8092 },
  // dcm2niix's frame workers load their WASM by URL; pre-bundling breaks it.
  optimizeDeps: { exclude: ['@niivue/dcm2niix'] },
  build: { outDir: 'dist', target: 'esnext' },
})
