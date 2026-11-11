import { defineConfig } from 'vite'
import dts from 'vite-plugin-dts'

export default defineConfig({
  plugins: [
    dts({ tsconfigPath: './tsconfig.json', exclude: ['src/**/*.test.ts'] }),
  ],
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    lib: {
      entry: 'src/index.ts',
      formats: ['es'],
      fileName: 'nv-ext-drawing',
    },
    rolldownOptions: {
      external: ['@niivue/niivue'],
    },
  },
})
