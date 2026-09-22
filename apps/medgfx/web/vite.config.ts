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
  // Keep the workspace bridge as source in Debug. Prebundling it would hide
  // edits behind Vite's dependency cache until the dev server is restarted.
  optimizeDeps: {
    exclude: ['@niivue/web-bridge'],
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
    rollupOptions: {
      // Two entries, one build. The app page and the Quick Look preview page
      // are separate documents but share NiiVue, so a multi-page build emits
      // the library once as a common chunk instead of duplicating ~1.3 MB into
      // both the app bundle and the extension bundle.
      input: {
        index: 'index.html',
        quicklook: 'quicklook.html',
      },
    },
  },
})
