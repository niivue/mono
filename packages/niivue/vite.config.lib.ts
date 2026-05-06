import { readFileSync } from 'node:fs'
import { extname } from 'node:path'
import { fileURLToPath, URL } from 'node:url'
import type { Plugin } from 'vite'
import { defineConfig } from 'vite'
import dts from 'vite-plugin-dts'

/**
 * Rollup plugin that inlines image assets as base64 data URIs in lib mode.
 *
 * We cannot emit separate asset files and reference them via
 * `new URL('./foo.png', import.meta.url)` because Vite's `optimizeDeps`
 * (esbuild) moves the bundled JS into `.vite/deps/` without copying the
 * referenced assets, breaking runtime asset resolution for downstream
 * consumers. See: https://github.com/niivue/mono/issues/10
 *
 * Fonts and matcaps ship as separate lib entry points (see build.lib.entry
 * below), so inlining them does not bloat the main bundle — only code that
 * actually imports them pays the base64 overhead.
 */
function inlineImageAssets(): Plugin {
  const MIME: Record<string, string> = {
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
  }
  return {
    name: 'inline-image-assets',
    enforce: 'pre',
    load(id) {
      const ext = extname(id).toLowerCase()
      const mime = MIME[ext]
      if (!mime) return null
      const base64 = readFileSync(id).toString('base64')
      const dataUrl = `data:${mime};base64,${base64}`
      return `export default ${JSON.stringify(dataUrl)}`
    },
  }
}

const PERF_BUILD = process.env.NIIVUE_PERF === '1'

export default defineConfig({
  publicDir: false,
  define: {
    __NIIVUE_PERF__: JSON.stringify(PERF_BUILD),
  },
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
  plugins: [
    inlineImageAssets(),
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
    },
  },
})
