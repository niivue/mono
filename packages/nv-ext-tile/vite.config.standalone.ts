/**
 * Standalone ES modules for pages with no bundler: dist/standalone/{tiff,dicom,
 * zarr}.js. geotiff and zarrita are bundled in and workers are inlined; only
 * `@niivue/niivue` (and, for /dicom, the optional `@niivue/dcm2niix`) stay bare
 * imports, which the page maps with an import map onto core's standalone
 * build, so extension and page share one core. scripts/check-standalone.ts
 * verifies the folder.
 */
import { defineConfig } from 'vite'
import { coreFromSource } from './vite.config'

export default defineConfig({
  worker: {
    plugins: () => [coreFromSource],
    rollupOptions: { output: { inlineDynamicImports: true } },
  },
  build: {
    outDir: 'dist/standalone',
    emptyOutDir: true,
    target: 'es2022',
    minify: 'esbuild',
    lib: {
      entry: {
        tiff: 'src/tiff.ts',
        dicom: 'src/dicom.ts',
        zarr: 'src/zarr.ts',
      },
      formats: ['es'],
    },
    rollupOptions: {
      external: ['@niivue/niivue', '@niivue/dcm2niix'],
      output: { chunkFileNames: 'chunks/[name]-[hash].js' },
    },
  },
})
