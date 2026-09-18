import { fileURLToPath, URL } from 'node:url'
import { devImagesPlugin } from '@niivue/dev-images/vite-plugin'
import { defineConfig } from 'vite'

export default defineConfig({
  optimizeDeps: {
    // dcm2niix creates a module Worker with a relative worker URL. Keeping it
    // out of Vite's dependency pre-bundle preserves the worker asset path.
    exclude: ['@niivue/dcm2niix'],
  },
  plugins: [devImagesPlugin()],
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
  server: {
    port: 8080,
  },
})
