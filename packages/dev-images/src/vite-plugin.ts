import fs from 'node:fs'
import { dirname, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Connect, Plugin } from 'vite'
import { SYNTHETIC_ZARR_ROOT, syntheticZarrFile } from './syntheticZarr.ts'

const __dirname = dirname(fileURLToPath(import.meta.url))
const imagesDir = resolve(__dirname, '../images')

/**
 * Recursively collect all files in a directory, returning paths relative to the base.
 */
function walkDir(dir: string, base: string): string[] {
  const results: string[] = []
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    // Skip dotfiles (e.g. macOS .DS_Store) so they are neither served nor
    // emitted into build output.
    if (entry.name.startsWith('.')) continue
    const full = resolve(dir, entry.name)
    if (entry.isDirectory()) {
      results.push(...walkDir(full, base))
    } else {
      results.push(relative(base, full))
    }
  }
  return results
}

const serveImage: Connect.NextHandleFunction = (req, res, next) => {
  if (!req.url || req.url === '/') return next()

  if (req.url.startsWith(SYNTHETIC_ZARR_ROOT)) {
    const path = req.url.split('?')[0].slice(SYNTHETIC_ZARR_ROOT.length)
    const body = syntheticZarrFile(path)
    if (!body) {
      res.statusCode = 404
      res.end()
      return
    }
    res.setHeader('Content-Length', body.byteLength)
    res.setHeader('Content-Type', 'application/octet-stream')
    res.end(body)
    return
  }

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

    // Preview too: the e2e suite runs against a build that does not emit images.
    configurePreviewServer(server) {
      server.middlewares.use(serveImage)
    },

    configureServer(server) {
      server.middlewares.use(serveImage)
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
