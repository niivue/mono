import { readFileSync } from 'node:fs'
import { basename } from 'node:path'
import { fileURLToPath, URL } from 'node:url'
import type { Plugin } from 'vite'
import { defineConfig } from 'vite'
import dts from 'vite-plugin-dts'

/**
 * Rollup plugin that emits image assets as separate files in lib mode
 * instead of inlining them as base64 data URIs.
 */
function emitAssetFiles(): Plugin {
  return {
    name: 'emit-asset-files',
    enforce: 'pre',
    load(id) {
      // Match image imports from asset modules
      const match = id.match(/\.(png|jpe?g)$/)
      if (!match) return null
      const source = readFileSync(id)
      const fileName = `assets/${basename(id)}`
      const ref = this.emitFile({
        type: 'asset',
        name: basename(id),
        fileName,
        source,
      })
      return `export default import.meta.ROLLUP_FILE_URL_${ref}`
    },
  }
}

export default defineConfig({
  publicDir: false,
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
  plugins: [
    emitAssetFiles(),
    dts({
      tsconfigPath: './tsconfig.json',
      exclude: ['**/*.test.ts'],
      pathsToAliases: true,
      beforeWriteFile(filePath, content) {
        // Rewrite any remaining @/ path aliases to relative paths
        const distDir = fileURLToPath(new URL('./dist', import.meta.url))
        const fileDir = filePath.substring(0, filePath.lastIndexOf('/'))
        const srcRelative = fileDir.startsWith(distDir)
          ? fileDir.substring(distDir.length + 1)
          : ''
        const depth = srcRelative ? srcRelative.split('/').length : 0
        const prefix = depth > 0 ? '../'.repeat(depth) : './'
        return {
          content: content.replace(
            /from\s+['"]@\/([^'"]+)['"]/g,
            (_match, p) => `from '${prefix}${p}'`,
          ),
        }
      },
    }),
  ],
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    assetsInlineLimit: 0,
    lib: {
      entry: {
        niivuegpu: fileURLToPath(new URL('./src/index.ts', import.meta.url)),
        'niivuegpu.webgpu': fileURLToPath(
          new URL('./src/index.webgpu.ts', import.meta.url),
        ),
        'niivuegpu.webgl2': fileURLToPath(
          new URL('./src/index.webgl2.ts', import.meta.url),
        ),
        'assets/fonts/index': fileURLToPath(
          new URL('./src/assets/fonts/index.ts', import.meta.url),
        ),
        'assets/matcaps/index': fileURLToPath(
          new URL('./src/assets/matcaps/index.ts', import.meta.url),
        ),
      },
      formats: ['es'],
    },
    rollupOptions: {
      external: ['cbor-x', 'gl-matrix', 'nifti-reader-js'],
      output: {
        assetFileNames: 'assets/[name][extname]',
      },
    },
  },
})
