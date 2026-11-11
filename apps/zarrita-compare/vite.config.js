import { defineConfig } from 'vite'

// Cross-origin isolation lets the page also time zarrita-rs's shared-output mode.
const isolation = {
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Embedder-Policy': 'require-corp',
}

export default defineConfig({
  base: process.env.VITE_BASE || '/',
  server: { port: 8093, headers: isolation },
  preview: { headers: isolation },
  // zarrita-rs loads its worker and .wasm by URL; pre-bundling breaks that.
  optimizeDeps: { exclude: ['@niivue/zarrita-rs'] },
  worker: { format: 'es' },
  build: { outDir: 'dist', target: 'esnext' },
})
