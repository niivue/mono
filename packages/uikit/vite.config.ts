import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { devImagesPlugin } from '@niivue/dev-images/vite-plugin'
import { defineConfig } from 'vite'
import dts from 'vite-plugin-dts'
import { slideFixturesPlugin } from './vite-slide-fixtures'

const here = dirname(fileURLToPath(import.meta.url))

// On build: emit type declarations for the library. On serve (the demo dev
// server): mount the shared dev-images plugin so the demos can load real volumes
// from `/volumes/...` (e.g. /volumes/mni152.nii.gz).
export default defineConfig(({ command }) => ({
  plugins:
    command === 'build'
      ? [
          dts({
            entryRoot: 'src',
            exclude: ['src/**/*.test.ts'],
            tsconfigPath: './tsconfig.json',
          }),
        ]
      : [
          devImagesPlugin(),
          slideFixturesPlugin(resolve(here, '../niivue/public')),
        ],
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    lib: {
      entry: 'src/index.ts',
      formats: ['es'],
      fileName: 'uikit',
    },
    // UIKit brings its own rendering; @niivue/niivue is only a peer for the
    // lifecycle hook (added later), so keep it external when it is used.
    rollupOptions: {
      external: ['@niivue/niivue'],
    },
  },
}))
