// Mounts the IIIF Image API 3.0 routes for slice rendering:
//   /iiif/image/{volId}/{axis}/{slice}/info.json
//   /iiif/image/{volId}/{axis}/{slice}/{region}/{size}/{rotation}/{quality}.{format}

import type {
  Express,
  NextFunction,
  Request,
  RequestHandler,
  Response,
} from 'express'

import type { Axis, VolumeHandle } from '../adapters/volumeHandle.ts'
import { infoJson, renderImageRequest } from '../iiif/imageApi.ts'
import type { Registry } from '../registry.ts'

const AXES: Set<Axis> = new Set(['axial', 'coronal', 'sagittal'])

class HttpError extends Error {
  constructor(public status: number, message: string) {
    super(message)
  }
}

export function mountImageApi(app: Express, registry: Registry): void {
  app.get(
    '/iiif/image/:volId/:axis/:slice/info.json',
    asyncHandler((req, res) => sendInfo(req, res, registry)),
  )

  app.get(
    '/iiif/image/:volId/level/:level/:axis/:slice/info.json',
    asyncHandler((req, res) => sendInfo(req, res, registry)),
  )

  app.get(
    '/iiif/image/:volId/:axis/:slice/:region/:size/:rotation/:qualityFormat',
    asyncHandler((req, res) => sendImage(req, res, registry)),
  )

  app.get(
    '/iiif/image/:volId/level/:level/:axis/:slice/:region/:size/:rotation/:qualityFormat',
    asyncHandler((req, res) => sendImage(req, res, registry)),
  )

  app.get(
    '/iiif/image/:volId/:axis/:slice',
    asyncHandler(async (req, res) => {
      res.redirect(
        302,
        `/iiif/image/${encodeURIComponent(req.params.volId)}/${req.params.axis}/${req.params.slice}/info.json`,
      )
    }),
  )
}

async function sendInfo(
  req: Request,
  res: Response,
  registry: Registry,
): Promise<void> {
  const { volId } = req.params
  const axis = parseAxis(req.params.axis)
  const sliceIndex = Number(req.params.slice)
  const level = parseLevel(req.params.level ?? req.query.level)
  validateSliceIndex(sliceIndex)
  const { volume } = await registry.loadLevel(volId, level)
  validateSliceRange(volume, axis, sliceIndex)
  const [w, h] = volume.physicalSliceDims(axis)
  const baseUrl = req.app.locals.publicBaseUrl as string
  res.set('Content-Type', 'application/ld+json')
  res.json(
    infoJson({
      baseUrl,
      volId,
      axis,
      sliceIndex,
      width: w,
      height: h,
      level,
    }),
  )
}

async function sendImage(
  req: Request,
  res: Response,
  registry: Registry,
): Promise<void> {
  const { volId, region, size, rotation } = req.params
  const axis = parseAxis(req.params.axis)
  const sliceIndex = Number(req.params.slice)
  const level = parseLevel(req.params.level ?? req.query.level)
  validateSliceIndex(sliceIndex)
  const [quality, format] = splitQualityFormat(req.params.qualityFormat)
  const { volume } = await registry.loadLevel(volId, level)
  validateSliceRange(volume, axis, sliceIndex)
  const { buffer, contentType } = await renderImageRequest(
    volume,
    axis,
    sliceIndex,
    { region, size, rotation, quality, format },
  )
  res.set('Content-Type', contentType)
  res.set('Cache-Control', 'public, max-age=3600')
  res.send(buffer)
}

function parseAxis(axis: string): Axis {
  if (!AXES.has(axis as Axis)) {
    throw new HttpError(400, `Unknown axis: ${axis}`)
  }
  return axis as Axis
}

function validateSliceIndex(sliceIndex: number): void {
  if (!Number.isInteger(sliceIndex) || sliceIndex < 0) {
    throw new HttpError(400, `Invalid slice index: ${sliceIndex}`)
  }
}

function validateSliceRange(
  volume: VolumeHandle,
  axis: Axis,
  sliceIndex: number,
): void {
  const n = volume.sliceCount(axis)
  if (sliceIndex >= n) {
    throw new HttpError(
      416,
      `Slice index ${sliceIndex} out of range for axis ${axis} at this level (0..${n - 1})`,
    )
  }
}

function parseLevel(s: string | undefined | string[] | unknown): number {
  if (s === undefined || s === null || s === '') return 0
  const n = Number(s)
  if (!Number.isInteger(n) || n < 0) {
    throw new HttpError(400, `Invalid level: ${String(s)}`)
  }
  return n
}

function splitQualityFormat(s: string): [string, string] {
  const dot = s.lastIndexOf('.')
  if (dot < 0) {
    throw new HttpError(400, `Invalid quality.format: ${s}`)
  }
  return [s.slice(0, dot), s.slice(dot + 1).toLowerCase()]
}

type AsyncRouteHandler = (req: Request, res: Response) => Promise<void>

function asyncHandler(fn: AsyncRouteHandler): RequestHandler {
  return (req: Request, res: Response, next: NextFunction) =>
    Promise.resolve(fn(req, res)).catch(next)
}
