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
      entry: { tiff: 'src/tiff.ts', dicom: 'src/dicom.ts' },
      formats: ['es'],
    },
    rollupOptions: {
      external: ['@niivue/niivue', '@niivue/dcm2niix', 'geotiff'],
    },
  },
})
