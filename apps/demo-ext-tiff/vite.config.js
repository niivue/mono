import { defineConfig } from 'vite'

// VITE_BASE: the app's own base path (e.g. /mono/demo-ext-tiff/)
export default defineConfig({
  base: process.env.VITE_BASE || '/',
  server: { port: 8092 },
  build: { outDir: 'dist', target: 'esnext' },
})
