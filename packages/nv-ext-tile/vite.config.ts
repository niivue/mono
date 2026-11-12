import { fileURLToPath } from 'node:url'
import { defineConfig, type Plugin } from 'vite'
import dts from 'vite-plugin-dts'

// The chunk worker keeps its own copy of the few core helpers it calls (chunk
// timing, voxel utils), as it did inside core. Built against core's dist it
// would also keep that chunk's top-level code (readers, other workers), about
// 0.5 MB, so the worker bundle alone reads core from source.
const coreSrc = fileURLToPath(new URL('../niivue/src/', import.meta.url))
const coreFromSource: Plugin = {
  name: 'worker-core-from-source',
  enforce: 'pre',
  resolveId(id, importer) {
    if (id === '@niivue/niivue') return this.resolve(`${coreSrc}index.ts`)
    if (id.startsWith('@/') && importer?.startsWith(coreSrc))
      return this.resolve(coreSrc + id.slice(2), importer)
  },
}

// Shared with vite.config.standalone.ts. The Zarr chunk worker is inlined as
// one blob, which has nowhere to fetch a chunk from, so zarrita-rs's dynamically
// imported codecs fold into it.
export const worker = {
  plugins: () => [coreFromSource],
  rolldownOptions: { output: { codeSplitting: false } },
}
export const entry = {
  tiff: 'src/tiff.ts',
  dicom: 'src/dicom.ts',
  zarr: 'src/zarr.ts',
  open: 'src/open.ts',
}

export default defineConfig({
  plugins: [
    dts({ tsconfigPath: './tsconfig.json', exclude: ['src/**/*.test.ts'] }),
  ],
  worker,
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    lib: {
      entry,
      formats: ['es'],
    },
    rolldownOptions: {
      external: [
        '@niivue/niivue',
        '@niivue/dcm2niix',
        '@niivue/geotiff-rs',
        /^@niivue\/zarrita-rs(\/|$)/,
      ],
    },
  },
})
