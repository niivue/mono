import { fileURLToPath, URL } from 'node:url'
import { defineConfig } from 'vite'
import { coreChunkFileNames, inlineImageAssets } from './vite.config.lib'

/**
 * Self-contained ES module build for bundler-free use (`dist/standalone/`).
 *
 * The main library build (vite.config.lib.ts) leaves cbor-x, gl-matrix and
 * nifti-reader-js as bare imports for the consumer's bundler to
 * resolve. A browser cannot load those from a plain `<script type="module">`
 * without an import map for every dependency, so this build inlines all of
 * them. It keeps code splitting: optional paths stay in lazily imported chunks
 * under `chunks/`, and Rolldown writes every chunk import as a relative path, so the
 * folder works from any base URL. Workers are already blob-inlined
 * (`?worker&inline`) and images are inlined as data URIs, so the folder has
 * no other runtime files.
 *
 * Runs after the library build (which empties dist/), see the `build` script.
 * scripts/check-standalone.ts then fails the build if a bare import survives.
 */

const entry = (path: string) => fileURLToPath(new URL(path, import.meta.url))

export default defineConfig({
  publicDir: false,
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
  plugins: [inlineImageAssets()],
  build: {
    outDir: 'dist/standalone',
    emptyOutDir: true,
    target: 'es2022',
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
    // No externals: every dependency is bundled into the folder.
    rolldownOptions: {
      output: {
        chunkFileNames: coreChunkFileNames('chunks/'),
        // Vite keeps whitespace in ES library output so pure annotations
        // survive a consumer's bundler. Nothing re-bundles this folder, so
        // strip it (over a quarter of the bytes).
        minify: { codegen: { removeWhitespace: true } },
        // Vite drops legal comments when minifying; keep any licence notice
        // a bundled dependency carries.
        comments: { legal: true },
      },
    },
  },
})
