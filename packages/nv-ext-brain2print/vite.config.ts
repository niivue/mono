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
      fileName: 'nv-ext-brain2print',
    },
    rollupOptions: {
      external: [
        '@itk-wasm/cuberille',
        '@itk-wasm/mesh-filters',
        '@niivue/niivue',
        '@niivue/nv-ext-image-processing',
        '@niivue/nv-ext-niimath',
        'cbor-x',
      ],
    },
  },
})
