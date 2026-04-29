import { defineConfig } from 'vite'
import dts from 'vite-plugin-dts'

export default defineConfig({
  plugins: [dts({ tsconfigPath: './tsconfig.json' })],
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    lib: {
      entry: 'src/index.ts',
      formats: ['es'],
      fileName: 'nv-ext-dcm2niix',
    },
    rollupOptions: {
      external: ['@niivue/niivue', '@niivue/dcm2niix'],
    },
  },
})
