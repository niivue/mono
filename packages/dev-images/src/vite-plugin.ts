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

/**
 * Vite plugin that serves images from @niivue/dev-images during dev
 * and emits them as assets during build.
 *
 * Files in the images directory are served at their relative path.
 * For example, `images/volumes/mni152.nii.gz` is served at `/volumes/mni152.nii.gz`.
 */
export function devImagesPlugin(): Plugin {
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
