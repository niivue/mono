import { fileURLToPath } from 'node:url'
import { devImagesPlugin } from '@niivue/dev-images/vite-plugin'
import { defineConfig } from 'vite'

export default defineConfig({
  plugins: [devImagesPlugin()],
  server: {
    port: 8082,
    headers: {
      'Cross-Origin-Opener-Policy': 'same-origin',
      'Cross-Origin-Embedder-Policy': 'require-corp',
    },
  },
  build: {
    outDir: 'dist',
    target: 'esnext',
    rollupOptions: {
      input: {
        drawing: fileURLToPath(new URL('drawing.html', import.meta.url)),
        magicWand: fileURLToPath(new URL('magic-wand.html', import.meta.url)),
      },
    },
  },
})
