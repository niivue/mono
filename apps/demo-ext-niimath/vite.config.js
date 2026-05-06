import {
  devImagesPlugin,
  ghPagesRewritePlugin,
} from '@niivue/dev-images/vite-plugin'
import { defineConfig } from 'vite'

export default defineConfig({
  base: process.env.VITE_BASE || '/',
  plugins: [
    devImagesPlugin({ emit: !process.env.VITE_IMAGES_BASE }),
    ghPagesRewritePlugin(),
  ],
  // The underlying @niivue/niimath WASM worker uses a dynamic import that
  // chokes when prebundled; let Vite leave it alone (matches the pattern
  // demo-ext-dcm2niix uses for @niivue/dcm2niix). nv-ext-niimath is the
  // workspace wrapper that re-exports it.
  optimizeDeps: {
    exclude: ['@niivue/niimath', '@niivue/nv-ext-niimath'],
  },
  server: {
    port: 8089,
  },
  build: {
    outDir: 'dist',
    target: 'esnext',
    rollupOptions: {
      input: 'index.html',
    },
  },
})
