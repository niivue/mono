import fs from 'node:fs'
import { resolve } from 'node:path'
import type { Plugin } from 'vite'

// Dev-only: serve NiiVue's committed/fetched slide fixtures (DICOM-WSI, SVS)
// living under packages/niivue/public so the WSI ruler demo can load a real
// tissue sample. Unlike the dev-images plugin, this honours HTTP Range requests
// (206), which the DICOM-WSI tile source needs to pull individual tile byte
// ranges out of the multi-hundred-MB .dcm files instead of the whole file.
export function slideFixturesPlugin(fixturesDir: string): Plugin {
  const root = resolve(fixturesDir)
  const prefixes = ['dicom-wsi/', 'svs/']
  return {
    name: 'uikit-slide-fixtures',
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        if (!req.url) return next()
        const urlPath = req.url.split('?')[0].replace(/^\//, '')
        if (!prefixes.some((p) => urlPath.startsWith(p))) return next()
        const filePath = resolve(root, urlPath)
        if (!filePath.startsWith(root)) return next() // no path traversal
        let stat: fs.Stats
        try {
          stat = fs.statSync(filePath)
        } catch {
          return next()
        }
        if (!stat.isFile()) return next()
        res.setHeader('Accept-Ranges', 'bytes')
        res.setHeader(
          'Content-Type',
          urlPath.endsWith('.json')
            ? 'application/json'
            : 'application/octet-stream',
        )
        const range = req.headers.range
        const match = range && /^bytes=(\d+)-(\d*)$/.exec(range)
        if (match) {
          const start = Number(match[1])
          const end = match[2] ? Number(match[2]) : stat.size - 1
          res.statusCode = 206
          res.setHeader('Content-Range', `bytes ${start}-${end}/${stat.size}`)
          res.setHeader('Content-Length', end - start + 1)
          fs.createReadStream(filePath, { start, end }).pipe(res)
          return
        }
        res.setHeader('Content-Length', stat.size)
        fs.createReadStream(filePath).pipe(res)
      })
    },
  }
}
