import { fileURLToPath, URL } from 'node:url'
import type { Plugin } from 'vite'
import { defineConfig, transformWithEsbuild } from 'vite'
import { inlineImageAssets } from './vite.config.lib'

/**
 * Self-contained ES module build for bundler-free use (`dist/standalone/`).
 *
 * The main library build (vite.config.lib.ts) leaves cbor-x, gl-matrix,
 * nifti-reader-js and zarrita as bare imports for the consumer's bundler to
 * resolve. A browser cannot load those from a plain `<script type="module">`
 * without an import map for every dependency, so this build inlines all of
 * them. It keeps code splitting: optional paths (the OME-Zarr blosc/lz4/zstd
 * codecs and the zarr chunk worker pool) stay in lazily imported chunks under
 * `chunks/`, and Rollup writes every chunk import as a relative path, so the
 * folder works from any base URL. Workers are already blob-inlined
 * (`?worker&inline`) and images are inlined as data URIs, so the folder has
 * no other runtime files.
 *
 * Runs after the library build (which empties dist/), see the `build` script.
 * scripts/check-standalone.ts then fails the build if a bare import survives.
 */

/**
 * Vite never strips whitespace from ES-format library output, so that pure
 * annotations survive for the consumer's bundler. Nothing re-bundles this
 * folder, so minify the whitespace too (over a quarter of the bytes).
 */
function minifyWhitespace(): Plugin {
  return {
    name: 'standalone-minify-whitespace',
    // generateBundle, not renderChunk: Vite's own esbuild renderChunk pass
    // would reprint the code with whitespace after an earlier renderChunk.
    async generateBundle(_options, bundle) {
      for (const chunk of Object.values(bundle)) {
        if (chunk.type !== 'chunk') continue
        const result = await transformWithEsbuild(chunk.code, chunk.fileName, {
          loader: 'js',
          format: 'esm',
          target: 'es2022',
          minifyWhitespace: true,
          sourcemap: false,
        })
        chunk.code = result.code
      }
    },
  }
}

const entry = (path: string) => fileURLToPath(new URL(path, import.meta.url))

export default defineConfig({
  publicDir: false,
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
  plugins: [inlineImageAssets(), minifyWhitespace()],
  // Same reason as the library build: an inlined worker is a single blob and
  // cannot fetch the codec chunks zarrita imports dynamically.
  worker: {
    rollupOptions: { output: { inlineDynamicImports: true } },
  },
  build: {
    outDir: 'dist/standalone',
    emptyOutDir: true,
    target: 'es2022',
    minify: 'esbuild',
    lib: {
      entry: {
        niivue: entry('./src/index.ts'),
        'niivue.webgpu': entry('./src/index.webgpu.ts'),
        'niivue.webgl2': entry('./src/index.webgl2.ts'),
        viewport: entry('./src/control/NVCanvasViewportController.ts'),
        'assets/fonts/index': entry('./src/assets/fonts/index.ts'),
        'assets/matcaps/index': entry('./src/assets/matcaps/index.ts'),
      },
      formats: ['es'],
    },
    rollupOptions: {
      // Nothing is external: every dependency is bundled into the folder.
      external: [],
      output: {
        // Rollup names a shared chunk after one of its modules, which labels
        // the core chunk (the controller and everything every entry needs)
        // after an incidental OME-Zarr helper. Name it for what it is.
        chunkFileNames: (chunk) =>
          chunk.moduleIds.some((id) => id.endsWith('/src/NVControlBase.ts'))
            ? 'chunks/core-[hash].js'
            : 'chunks/[name]-[hash].js',
      },
    },
  },
})
