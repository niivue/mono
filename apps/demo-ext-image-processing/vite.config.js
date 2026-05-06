import { fileURLToPath } from 'node:url'
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
  server: {
    port: 8081,
  },
  build: {
    outDir: 'dist',
    target: 'esnext',
    rollupOptions: {
      input: {
        imgproc: fileURLToPath(new URL('imgproc.html', import.meta.url)),
      },
    },
  },
})
