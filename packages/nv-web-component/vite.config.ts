import { defineConfig } from 'vite'
import dts from 'vite-plugin-dts'

export default defineConfig({
  plugins: [
    dts({
      entryRoot: 'src',
      exclude: ['src/**/*.test.ts', 'src/**/__mocks__/**'],
      tsconfigPath: './tsconfig.json',
    }),
  ],
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    lib: {
      entry: 'src/niivue-web-component.ts',
      formats: ['es'],
      fileName: 'nv-web-component',
    },
    rollupOptions: {
      external: ['@niivue/niivue'],
    },
  },
})
