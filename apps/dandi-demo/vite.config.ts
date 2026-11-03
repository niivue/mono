import { resolve } from 'node:path'
import { devImagesPlugin } from '@niivue/dev-images/vite-plugin'
import { defineConfig } from 'vite'

const ghBase = process.env.VITE_BASE ?? ''

export default defineConfig({
  base: ghBase || '/',
  // No SPA fallback: a missing file must 404 (as on S3), or zarrita's format
  // probe (zarr.json) reads index.html when the demo runs on a ?local copy.
  appType: 'mpa',
  // Serves the synthetic store; the published demo streams from DANDI only.
  plugins: [devImagesPlugin({ emit: false })],
  // Do NOT pre-bundle the local workspace builds. Vite caches a pre-bundled copy
  // at dev-server start and does not invalidate it when a package's dist/ is
  // rebuilt, so editing niivue or uikit source + `nx build` would keep serving
  // the OLD bundle until the cache is cleared.
  optimizeDeps: { exclude: ['@niivue/niivue', '@niivue/uikit'] },
  server: {
    port: 8090,
  },
  build: {
    outDir: 'dist',
    target: 'esnext',
    rollupOptions: {
      input: {
        index: resolve(__dirname, 'index.html'),
      },
    },
  },
})
