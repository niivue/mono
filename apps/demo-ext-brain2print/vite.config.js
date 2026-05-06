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
  // Vite's dep prebundler trips on dynamic-import WASM workers used by both
  // @niivue/niimath and the @itk-wasm/* mesh pipelines. Excluding them keeps
  // the worker scripts as standalone modules so the runtime URLs resolve.
  optimizeDeps: {
    exclude: [
      '@itk-wasm/cuberille',
      '@itk-wasm/mesh-filters',
      '@niivue/niimath',
      '@niivue/nv-ext-niimath',
      'itk-wasm',
    ],
  },
  server: {
    port: 8090,
  },
  build: {
    outDir: 'dist',
    target: 'esnext',
    rollupOptions: {
      input: 'index.html',
    },
  },
})
