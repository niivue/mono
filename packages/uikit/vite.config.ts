import { defineConfig } from 'vite'
import dts from 'vite-plugin-dts'

// The library build. The demo pages are apps/demo-uikit.
export default defineConfig({
  plugins: [
    dts({
      entryRoot: 'src',
      exclude: ['src/**/*.test.ts'],
      tsconfigPath: './tsconfig.json',
      // The plugin drops triple-slash directives; the hook types need the
      // WebGPU globals (a peer) in a consumer's typecheck.
      beforeWriteFile: (filePath, content) =>
        filePath.endsWith('/hook.d.ts')
          ? {
              filePath,
              content: `/// <reference types="@webgpu/types" />\n${content}`,
            }
          : undefined,
    }),
  ],
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    lib: {
      entry: { uikit: 'src/index.ts', controls: 'src/controlsEntry.ts' },
      formats: ['es'],
    },
  },
})
