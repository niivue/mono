import { defineConfig } from 'vite'
import dts from 'vite-plugin-dts'

// Multi-entry library build. Each source module ships as its own entry
// (see package.json#exports) so consumers import subpaths directly and
// we don't need a barrel file (Biome: noBarrelFile: error).
export default defineConfig({
  plugins: [dts({ tsconfigPath: './tsconfig.json' })],
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    lib: {
      entry: {
        bridge: 'src/bridge.ts',
        'prop-bridge': 'src/prop-bridge.ts',
        'prop-allowlist': 'src/prop-allowlist.ts',
        'niivue-controller': 'src/niivue-controller.ts',
      },
      formats: ['es'],
    },
    rollupOptions: {
      external: ['@niivue/niivue'],
    },
  },
})
