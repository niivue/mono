import { fileURLToPath, URL } from 'node:url'
import { devImagesPlugin } from '@niivue/dev-images/vite-plugin'
import { defineConfig } from 'vite'

const PERF_BUILD = process.env.NIIVUE_PERF === '1'

export default defineConfig({
  define: {
    __NIIVUE_PERF__: JSON.stringify(PERF_BUILD),
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
