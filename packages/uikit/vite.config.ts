import { devImagesPlugin } from '@niivue/dev-images/vite-plugin'
import { defineConfig } from 'vite'
import dts from 'vite-plugin-dts'

// On build: emit type declarations for the library. On serve (the demo dev
// server): mount the shared dev-images plugin so the demos can load real volumes
// from `/volumes/...` (e.g. /volumes/mni152.nii.gz). The WSI demo loads its
// tissue slide from the test-images repo over the network, so no local slide
// route is needed.
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
      : [devImagesPlugin()],
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
