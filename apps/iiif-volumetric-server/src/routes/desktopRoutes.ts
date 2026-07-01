import type { Express, Request, Response } from 'express'

import { buildDesktopManifest } from '../desktop/manifest.ts'
import type { Registry } from '../registry.ts'

export function mountDesktopRoutes(app: Express, registry: Registry): void {
  app.get('/iiif/desktop', (req: Request, res: Response) => {
    const baseUrl = req.app.locals.publicBaseUrl as string
    res.json({
      desktops: [
        {
          id: 'neuro',
          manifest: `${baseUrl}/iiif/desktop/neuro/manifest`,
          viewer: `${baseUrl}/osd-volume-desktop.html`,
        },
      ],
    })
  })

  app.get(
    '/iiif/desktop/:desktopId/manifest',
    (req: Request, res: Response) => {
      const baseUrl = req.app.locals.publicBaseUrl as string
      const manifest = buildDesktopManifest({
        baseUrl,
        desktopId: req.params.desktopId,
        volumes: registry.list().filter((v) => v.format === 'nifti'),
      })
      res.set('Content-Type', 'application/json')
      res.json(manifest)
    },
  )
}
