import { readdirSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath, URL } from 'node:url'
import { devImagesPlugin } from '@niivue/dev-images/vite-plugin'
import { defineConfig } from 'vite'

const root = fileURLToPath(new URL('.', import.meta.url))
const examplesDir = resolve(root, 'examples')

// Auto-discover all .html files in examples/
const htmlFiles = readdirSync(examplesDir).filter((f) => f.endsWith('.html'))
const input = Object.fromEntries(
  htmlFiles.map((f) => [f.replace('.html', ''), resolve(examplesDir, f)]),
)

export default defineConfig({
  plugins: [devImagesPlugin()],
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    rollupOptions: {
      input,
    },
  },
})
