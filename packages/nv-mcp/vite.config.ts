import { defineConfig } from 'vite'
import dts from 'vite-plugin-dts'

export default defineConfig({
  plugins: [
    dts({
      tsconfigPath: './tsconfig.json',
      exclude: ['src/**/*.test.ts', 'src/testing/**'],
    }),
  ],
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    lib: {
      entry: {
        index: 'src/index.ts',
        server: 'src/server/index.ts',
      },
      formats: ['es'],
    },
    rollupOptions: {
      // The server entry runs under Bun and imports its SDK from there; the
      // browser entry imports nothing. Neither is bundled in.
      external: [/^@modelcontextprotocol\/sdk/, 'zod', 'bun', /^node:/],
    },
  },
})
