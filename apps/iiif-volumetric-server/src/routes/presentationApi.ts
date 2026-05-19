// Mounts /iiif/presentation/{id}/manifest

import type { Express, Request, Response } from 'express'

import { planExplodedView } from '../iiif/explode.ts'
import { buildExplodedManifest, buildManifest } from '../iiif/presentation.ts'
import type { Registry } from '../registry.ts'
import { asyncHandler } from '../util/http.ts'

export function mountPresentationApi(app: Express, registry: Registry): void {
  app.get(
    '/iiif/presentation/:volId/manifest',
    asyncHandler(async (req, res) => {
      const entry = await registry.load(req.params.volId)
      const baseUrl = req.app.locals.publicBaseUrl as string
      const manifest = buildManifest({ baseUrl, entry })
      res.set('Content-Type', 'application/ld+json')
      res.json(manifest)
    }),
  )

  // Exploded-view manifest: Scene with one Model annotation per grid cell,
  // plus a `rendering` link to the composite NIfTI for clients that want
  // the whole exploded space as a single volume.
  app.get(
    '/iiif/presentation/:volId/exploded/manifest',
    asyncHandler(async (req, res) => {
      const entry = await registry.load(req.params.volId)
      if (!entry.volume) {
        throw new Error(`Volume ${entry.id} not loaded`)
      }
      const baseUrl = req.app.locals.publicBaseUrl as string
      const layout = planExplodedView(entry.volume, {
        nx: Number(req.query.nx ?? 3),
        ny: Number(req.query.ny ?? 3),
        nz: Number(req.query.nz ?? 3),
        explode: req.query.explode ? Number(req.query.explode) : undefined,
        ex: req.query.ex ? Number(req.query.ex) : undefined,
        ey: req.query.ey ? Number(req.query.ey) : undefined,
        ez: req.query.ez ? Number(req.query.ez) : undefined,
      })
      const wantsComposite = req.query.composite === '1'
      const manifest = buildExplodedManifest({
        baseUrl,
        entry,
        layout,
        wantsComposite,
      })
      res.set('Content-Type', 'application/ld+json')
      res.json(manifest)
    }),
  )

  app.get('/iiif/presentation', (req: Request, res: Response) => {
    const baseUrl = req.app.locals.publicBaseUrl as string
    res.json({
      manifests: registry.list().flatMap((v) => [
        {
          id: v.id,
          kind: 'single',
          manifest: `${baseUrl}/iiif/presentation/${encodeURIComponent(v.id)}/manifest`,
        },
        {
          id: v.id,
          kind: 'exploded-3x3x3-e1.5',
          manifest: `${baseUrl}/iiif/presentation/${encodeURIComponent(v.id)}/exploded/manifest?nx=3&ny=3&nz=3&ex=1.5&ey=1.5&ez=1.5`,
        },
      ]),
    })
  })
}
