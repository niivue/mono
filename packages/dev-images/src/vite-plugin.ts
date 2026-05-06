import fs from 'node:fs'
import { dirname, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Plugin } from 'vite'

const __dirname = dirname(fileURLToPath(import.meta.url))
const imagesDir = resolve(__dirname, '../images')

/**
 * Recursively collect all files in a directory, returning paths relative to the base.
 */
function walkDir(dir: string, base: string): string[] {
  const results: string[] = []
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = resolve(dir, entry.name)
    if (entry.isDirectory()) {
      results.push(...walkDir(full, base))
    } else {
      results.push(relative(base, full))
    }
  }
  return results
}

export interface DevImagesPluginOptions {
  /**
   * Whether to emit image files into the build output.
   * Set to `false` when images are served from a shared location
   * (e.g. a parent path on GitHub Pages). Default: `true`.
   */
  emit?: boolean
}

/**
 * Vite plugin that serves images from @niivue/dev-images during dev
 * and emits them as assets during build.
 *
 * Files in the images directory are served at their relative path.
 * For example, `images/volumes/mni152.nii.gz` is served at `/volumes/mni152.nii.gz`.
 */
export function devImagesPlugin(options?: DevImagesPluginOptions): Plugin {
  const shouldEmit = options?.emit ?? true
  return {
    name: 'niivue-dev-images',

    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        if (!req.url || req.url === '/') return next()

        const urlPath = req.url.split('?')[0].replace(/^\//, '')
        const filePath = resolve(imagesDir, urlPath)

        // Prevent path traversal
        if (!filePath.startsWith(imagesDir)) return next()

        let stat: fs.Stats
        try {
          stat = fs.statSync(filePath)
        } catch {
          return next()
        }
        if (!stat.isFile()) return next()
        res.setHeader('Content-Length', stat.size)
        res.setHeader('Content-Type', 'application/octet-stream')
        fs.createReadStream(filePath).pipe(res)
      })
    },

    generateBundle() {
      if (!shouldEmit) return
      for (const relPath of walkDir(imagesDir, imagesDir)) {
        const filePath = resolve(imagesDir, relPath)
        this.emitFile({
          type: 'asset',
          fileName: relPath,
          source: fs.readFileSync(filePath),
        })
      }
    },
  }
}

export interface GhPagesRewriteOptions {
  /**
   * URL prefix for shared `/volumes/` and `/meshes/` assets in the production
   * bundle. Defaults to `process.env.VITE_IMAGES_BASE ?? process.env.VITE_BASE`,
   * matching the env vars `.github/build-pages.sh` sets per app.
   */
  imagesBase?: string
  /**
   * Asset directories to rewrite. Defaults to `['volumes', 'meshes']` —
   * the two directories `@niivue/dev-images` ships.
   */
  dirs?: string[]
}

/**
 * Production-build plugin: rewrites absolute `"/volumes/…"` and `"/meshes/…"`
 * URLs in emitted JS to point at a shared base path. Use this together with
 * `devImagesPlugin({ emit: false })` when multiple demo apps share a single
 * copy of `@niivue/dev-images` from a GitHub Pages site root, instead of
 * each app bundling its own copy.
 *
 * Returns `null` when no base is configured (i.e. dev mode), so callers can
 * include it unconditionally in their `plugins` array.
 */
export function ghPagesRewritePlugin(
  options?: GhPagesRewriteOptions,
): Plugin | null {
  const base =
    options?.imagesBase ??
    process.env.VITE_IMAGES_BASE ??
    process.env.VITE_BASE ??
    ''
  if (!base) return null
  const dirs = options?.dirs ?? ['volumes', 'meshes']
  return {
    name: 'niivue-ghpages-rewrite-asset-urls',
    enforce: 'post',
    renderChunk(code) {
      let out = code
      for (const d of dirs) {
        out = out
          .replaceAll(`"/${d}/`, `"${base}${d}/`)
          .replaceAll(`'/${d}/`, `'${base}${d}/`)
          .replaceAll(`\`/${d}/`, `\`${base}${d}/`)
      }
      return out
    },
  }
}
