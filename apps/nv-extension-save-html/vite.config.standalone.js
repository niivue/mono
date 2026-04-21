/**
 * Builds a self-contained niivue ESM bundle with all dependencies inlined.
 * The output is placed in public/ so the main app can fetch() it at runtime.
 *
 * Run: npx vite build --config vite.config.standalone.js
 */
import { defineConfig } from 'vite'

export default defineConfig({
  publicDir: false,
  build: {
    outDir: 'public',
    emptyOutDir: false,
    lib: {
      entry: 'src/standalone-entry.js',
      formats: ['es'],
      fileName: () => 'niivue-standalone.js',
    },
    // Do NOT externalize anything — bundle all deps into one file
    rollupOptions: {
      external: [],
    },
    // Inline all assets (fonts, matcaps) as data URIs
    assetsInlineLimit: Number.MAX_SAFE_INTEGER,
  },
})
