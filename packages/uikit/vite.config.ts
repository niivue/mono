import { defineConfig } from 'vite'
import dts from 'vite-plugin-dts'

export default defineConfig({
  plugins: [
    dts({
      entryRoot: 'src',
      exclude: ['src/**/*.test.ts'],
      tsconfigPath: './tsconfig.json',
    }),
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
})
