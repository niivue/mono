import { defineConfig } from 'vite'

// `base: './'` so built asset URLs resolve under the native app's custom
// scheme (medgfx://app/). COOP/COEP enable crossOriginIsolated, which
// niivue's worker paths rely on for SharedArrayBuffer.
export default defineConfig({
  base: './',
  // Pick up @niivue/web-bridge's `development` export condition so the
  // dev server resolves to src/ and doesn't require a prior library build.
  resolve: {
    conditions: ['development', 'import', 'module', 'browser', 'default'],
  },
  server: {
    port: 8083,
    strictPort: true,
    headers: {
      'Cross-Origin-Opener-Policy': 'same-origin',
      'Cross-Origin-Embedder-Policy': 'require-corp',
    },
  },
  build: {
    outDir: 'dist',
    target: 'esnext',
    emptyOutDir: true,
  },
})
