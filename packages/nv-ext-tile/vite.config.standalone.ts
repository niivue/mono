/**
 * Standalone ES modules for pages with no bundler: dist/standalone/{tiff,dicom,
 * zarr}.js. geotiff-rs and zarrita-rs are bundled in and workers are inlined; only
 * `@niivue/niivue` (and, for /dicom and /tiff, the optional `@niivue/dcm2niix`,
 * imported lazily) stay bare imports, which the page maps with an import map
 * onto core's standalone build, so extension and page share one core.
 * scripts/check-standalone.ts verifies the folder.
 */
import { defineConfig } from 'vite'
import { entry, worker } from './vite.config'

export default defineConfig({
  worker,
  build: {
    outDir: 'dist/standalone',
    emptyOutDir: true,
    target: 'es2022',
    minify: 'oxc',
    lib: {
      entry,
      formats: ['es'],
    },
    rollupOptions: {
      external: ['@niivue/niivue', '@niivue/dcm2niix'],
      output: { chunkFileNames: 'chunks/[name]-[hash].js' },
    },
  },
})
