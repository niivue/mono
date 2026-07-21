// Raw volume endpoints. niivue (and any other NIfTI-aware client)
// fetches the bytes from here.
//
//   GET /volumes/{id}/raw          → original NIfTI bytes (gzip if source was)
//   GET /volumes/{id}/raw?bbox=x0,y0,z0,x1,y1,z1
//                                   → re-emitted NIfTI cropped to the box
//                                     (subvolume support for the 3D draft)
//   GET /volumes/{id}/raw.bin?bbox=x0,y0,z0,x1,y1,z1
//                                   → raw typed-array bytes cropped to the box
//                                     for brick streaming clients
//
// For non-NIfTI sources, /raw returns the original file (NRRD, OME-Zarr
// will need range-based access; here we just send what we have).

import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'
import { performance } from 'node:perf_hooks'

import type { Express, Request, Response } from 'express'

import type {
  Affine4x4,
  Dtype,
  Shape3,
  VolumeHandle,
} from '../adapters/volumeHandle.ts'
import { composeExplodedBuffer, planExplodedView } from '../iiif/explode.ts'
import type { RawLevelLayout, Registry, RegistryEntry } from '../registry.ts'
import { asyncHandler, HttpError, parseLevel } from '../util/http.ts'
import {
  type ContentEncoding,
  compressBuffer,
  dtypeByteSize,
  encodeNifti,
  encodeNiftiRaw,
  negotiateEncoding,
} from '../util/niftiEncoder.ts'
import { encodeNiftiRle, NIFTI_RLE_MEDIA_TYPE } from '../util/rleEncoder.ts'

const NIFTI_MEDIA_TYPE = 'application/x.nifti'
const NIFTI_GZIP_MEDIA_TYPE = 'application/x.nifti+gzip'

export interface Bbox {
  x0: number
  y0: number
  z0: number
  x1: number
  y1: number
  z1: number
}

function acceptsRle(req: Request): boolean {
  const accept = req.headers.accept || ''
  return accept.includes(NIFTI_RLE_MEDIA_TYPE)
}

// `.nii.gz` URL form is the legacy wire contract: the response body is
// pre-gzipped bytes with Content-Type "application/x.nifti+gzip" and no
// Content-Encoding header. Clients that sniff the `.gz` extension expect
// to self-decompress, so we must not advertise a real Content-Encoding —
// doing so causes the user-agent to decompress the body, then the client
// tries to decompress it again and either fails or shows a flash.
function legacyGzipWire(req: Request): boolean {
  return req.path.endsWith('.nii.gz')
}

const CROP_CACHE_MAX_BYTES = 128 * 1024 * 1024
const CROP_CACHE_MAX_ENTRIES = 512
const CROP_CACHE_MAX_ITEM_BYTES = 8 * 1024 * 1024
const cropResponseCache = new Map<string, Buffer>()
let cropResponseCacheBytes = 0

export function mountVolumeRoutes(app: Express, registry: Registry): void {
  app.get(
    '/volumes/:volId/raw.bin',
    asyncHandler(async (req, res) => {
      const entry = registry.get(req.params.volId)
      if (!entry) {
        throw new HttpError(404, `Unknown volume id: ${req.params.volId}`)
      }
      const bbox = parseBbox(req.query.bbox)
      if (!bbox) {
        throw new HttpError(400, 'raw.bin requires bbox=x0,y0,z0,x1,y1,z1')
      }
      const levelIdx = parseLevel(req.query.level)
      const { volume } = await registry.loadSubvolume(entry.id, levelIdx, bbox)
      const body = Buffer.from(
        volume.data.buffer,
        volume.data.byteOffset,
        volume.data.byteLength,
      )
      res.set('Content-Type', 'application/octet-stream')
      res.set('Content-Length', String(body.byteLength))
      res.set('Cache-Control', 'public, max-age=3600')
      res.set('X-Volume-Shape', volume.shape.join(','))
      res.set('X-Volume-Dtype', volume.dtype)
      res.send(body)
    }),
  )

  app.get(
    [
      '/volumes/:volId/raw',
      '/volumes/:volId/raw.nii.gz',
      '/volumes/:volId/raw.nii',
    ],
    asyncHandler(async (req, res) => {
      const entry = registry.get(req.params.volId)
      if (!entry) {
        throw new HttpError(404, `Unknown volume id: ${req.params.volId}`)
      }

      const bbox = parseBbox(req.query.bbox)
      const levelIdx = parseLevel(req.query.level)
      const urlWantsUncompressed =
        !req.path.endsWith('.nii.gz') && req.path.endsWith('.nii')

      if (!bbox && acceptsRle(req) && entry.dtype === 'uint8') {
        const { volume } = await registry.loadLevel(entry.id, levelIdx)
        if (!(volume.data instanceof Uint8Array)) {
          throw new HttpError(500, `Expected uint8 data, got ${volume.dtype}`)
        }
        const buffer = encodeNiftiRle({
          data: volume.data,
          shape: volume.shape,
          spacing: volume.spacing,
          dtype: 'uint8',
          affine: volume.affine,
          sclSlope: volume.sclSlope,
          sclInter: volume.sclInter,
        })
        res.set('Content-Type', NIFTI_RLE_MEDIA_TYPE)
        res.set(
          'Content-Disposition',
          `inline; filename="${entry.id}_L${levelIdx}.nii.rle"`,
        )
        res.set('Cache-Control', 'public, max-age=3600')
        res.set('Vary', 'Accept')
        res.send(buffer)
        return
      }

      if (!bbox && urlWantsUncompressed) {
        const rawLevel = await registry.getUncompressedNiftiLevel(
          entry.id,
          levelIdx,
        )
        res.set(
          'Content-Disposition',
          `inline; filename="${entry.id}_L${levelIdx}.nii"`,
        )
        res.set('Cache-Control', 'public, max-age=3600')
        res.sendFile(path.resolve(rawLevel.path), {
          acceptRanges: true,
          headers: { 'Content-Type': 'application/octet-stream' },
        })
        return
      }

      if (!bbox && levelIdx > 0) {
        const level = entry.levels.find((l) => l.level === levelIdx)
        if (!level) {
          throw new HttpError(
            404,
            `Level ${levelIdx} is not available for volume ${entry.id}`,
          )
        }
        if (level.path) {
          res.set('Content-Type', 'application/x.nifti+gzip')
          res.set(
            'Content-Disposition',
            `inline; filename="${entry.id}_L${levelIdx}.nii.gz"`,
          )
          res.set('Cache-Control', 'public, max-age=3600')
          fs.createReadStream(level.path).pipe(res)
          return
        }
        await serveLevelAsNifti(req, res, registry, entry, levelIdx)
        return
      }

      if (bbox) {
        if (entry.format !== 'nifti') {
          // Native-pyramid sources (OME-Zarr) ask the adapter for just
          // the slab, encode to NIfTI, then send. Skips the row-read
          // cache that the NIfTI fast path uses — the cache would
          // require materialising the full level on disk first, which
          // is exactly what we're trying to avoid for multi-GB levels.
          await serveSubvolumeAsNifti(req, res, registry, entry, levelIdx, bbox)
          return
        }

        if (acceptsRle(req) && entry.dtype === 'uint8') {
          const rawLevel = await registry.getUncompressedNiftiLevel(
            entry.id,
            levelIdx,
          )
          const meta = await cropRawNiftiData(
            rawLevel.path,
            rawLevel.layout,
            bbox,
          )
          const buffer = encodeNiftiRle({
            data: meta.data,
            shape: meta.shape,
            spacing: meta.spacing,
            dtype: 'uint8',
            affine: meta.affine,
            sclSlope: meta.sclSlope,
            sclInter: meta.sclInter,
          })
          res.set('Content-Type', NIFTI_RLE_MEDIA_TYPE)
          res.set(
            'Content-Disposition',
            `inline; filename="${entry.id}_L${levelIdx}_crop.nii.rle"`,
          )
          res.set('Cache-Control', 'public, max-age=3600')
          res.set('Vary', 'Accept')
          res.send(buffer)
          return
        }

        const legacyGzip = legacyGzipWire(req)
        const encoding: ContentEncoding = legacyGzip
          ? 'gzip'
          : negotiateEncoding(
              req.headers['accept-encoding'] as string | undefined,
            )
        const result = await cropNiftiResponse({
          registry,
          entry,
          levelIdx,
          bbox,
          encoding,
        })
        sendCroppedNifti(res, entry, levelIdx, result, {
          encoding,
          legacyGzip,
        })
        return
      }

      // Level 0, no bbox, no RLE, no .nii url. NIfTI streams its source
      // file as-is; native-pyramid adapters (OME-Zarr) have no single file,
      // so encode the loaded VolumeHandle into NIfTI bytes on the fly.
      const stat = await fsp.stat(entry.source)
      if (stat.isDirectory()) {
        await serveLevelAsNifti(req, res, registry, entry, 0)
        return
      }
      await streamSource(entry, res)
    }),
  )

  app.get(
    ['/volumes/:volId/exploded', '/volumes/:volId/exploded.nii.gz'],
    asyncHandler(async (req, res) => {
      const levelIdx = parseLevel(req.query.level)
      const { entry, volume: baseVolume } = await registry.loadLevel(
        req.params.volId,
        levelIdx,
      )
      const params = {
        nx: Number(req.query.nx ?? 3),
        ny: Number(req.query.ny ?? 3),
        nz: Number(req.query.nz ?? 3),
        explode: req.query.explode ? Number(req.query.explode) : undefined,
        ex: req.query.ex ? Number(req.query.ex) : undefined,
        ey: req.query.ey ? Number(req.query.ey) : undefined,
        ez: req.query.ez ? Number(req.query.ez) : undefined,
      }

      const layout = planExplodedView(baseVolume, params)
      const wantsComposite = req.query.composite === '1'

      if (!wantsComposite) {
        res.set('Cache-Control', 'public, max-age=3600')
        res.json({
          volumeId: entry.id,
          level: levelIdx,
          params: layout.params,
          cellShape: layout.cellShape,
          compositeShape: layout.compositeShape,
          compositeSpacing: layout.compositeSpacing,
          cellCount: layout.cells.length,
          cells: layout.cells,
        })
        return
      }

      const out = composeExplodedBuffer(baseVolume, layout)
      const rawBuffer = encodeNiftiRaw({
        data: out,
        shape: layout.compositeShape,
        spacing: layout.compositeSpacing,
        dtype: baseVolume.dtype,
        affine: baseVolume.affine,
        sclSlope: baseVolume.sclSlope,
        sclInter: baseVolume.sclInter,
      })
      const legacyGzip = legacyGzipWire(req)
      const encoding: ContentEncoding = legacyGzip
        ? 'gzip'
        : negotiateEncoding(
            req.headers['accept-encoding'] as string | undefined,
          )
      const body = compressBuffer(rawBuffer, encoding)
      if (legacyGzip) {
        res.set('Content-Type', NIFTI_GZIP_MEDIA_TYPE)
        res.set(
          'Content-Disposition',
          `inline; filename="${entry.id}_exploded.nii.gz"`,
        )
      } else {
        res.set('Content-Type', NIFTI_MEDIA_TYPE)
        if (encoding !== 'identity') {
          res.set('Content-Encoding', encoding)
        }
        res.set('Vary', 'Accept-Encoding')
        res.set(
          'Content-Disposition',
          `inline; filename="${entry.id}_exploded.nii"`,
        )
      }
      res.set('Cache-Control', 'public, max-age=3600')
      res.send(body)
    }),
  )

  app.get(
    '/volumes/:volId/exploded/plan',
    asyncHandler(async (req, res) => {
      const levelIdx = parseLevel(req.query.level)
      const { entry, volume: baseVolume } = await registry.loadLevel(
        req.params.volId,
        levelIdx,
      )
      const params = {
        nx: Number(req.query.nx ?? 3),
        ny: Number(req.query.ny ?? 3),
        nz: Number(req.query.nz ?? 3),
        explode: req.query.explode ? Number(req.query.explode) : undefined,
        ex: req.query.ex ? Number(req.query.ex) : undefined,
        ey: req.query.ey ? Number(req.query.ey) : undefined,
        ez: req.query.ez ? Number(req.query.ez) : undefined,
      }

      const layout = planExplodedView(baseVolume, params)
      res.json({
        volumeId: entry.id,
        level: levelIdx,
        params: layout.params,
        cellShape: layout.cellShape,
        compositeShape: layout.compositeShape,
        compositeSpacing: layout.compositeSpacing,
        cellCount: layout.cells.length,
        cells: layout.cells,
      })
    }),
  )

  app.get(
    '/volumes/:volId/occupancy',
    asyncHandler(async (req, res) => {
      const entry = registry.get(req.params.volId)
      if (!entry) {
        throw new HttpError(404, `Unknown volume id: ${req.params.volId}`)
      }
      const block = req.query.block ? Number(req.query.block) : 16
      const occ = await registry.getOccupancy(entry.id, block)
      const body = Buffer.from(
        occ.data.buffer,
        occ.data.byteOffset,
        occ.data.byteLength,
      )
      res.set('Content-Type', 'application/octet-stream')
      res.set('X-Occupancy-Dims', occ.dims.join(','))
      res.set('X-Occupancy-Block', String(occ.blockSize))
      res.set('Cache-Control', 'public, max-age=3600')
      res.send(body)
    }),
  )

  app.get(
    '/volumes/:volId/metadata',
    asyncHandler(async (req, res) => {
      const entry = await registry.load(req.params.volId)
      if (!entry.volume) {
        throw new HttpError(500, `Volume ${entry.id} not loaded`)
      }
      res.json({
        id: entry.id,
        format: entry.format,
        shape: entry.volume.shape,
        spacing: entry.volume.spacing,
        dtype: entry.volume.dtype,
        units: entry.volume.units,
        levels: entry.levels,
        intensityRange: entry.volume.intensityRange(),
        metadata: entry.volume.metadata,
      })
    }),
  )
}

interface CropNiftiResponseArgs {
  registry: Registry
  entry: RegistryEntry
  levelIdx: number
  bbox: Bbox
  encoding: ContentEncoding
}

interface CropNiftiResponseResult {
  buffer: Buffer
  cache: 'hit' | 'miss'
  source: string
  serverTiming: string
}

async function cropNiftiResponse(
  args: CropNiftiResponseArgs,
): Promise<CropNiftiResponseResult> {
  const { registry, entry, levelIdx, bbox, encoding } = args
  const timer = createServerTimer()
  const cacheKey = cropCacheKey(entry.id, levelIdx, bbox, encoding)
  const cached = getCropCache(cacheKey)
  if (cached) {
    timer.mark('cache-hit')
    return {
      buffer: cached,
      cache: 'hit',
      source: 'response-cache',
      serverTiming: timer.header(),
    }
  }

  let source = 'row-read'
  let body: Buffer
  try {
    const rawLevel = await registry.getUncompressedNiftiLevel(
      entry.id,
      levelIdx,
    )
    timer.mark('raw-cache')
    const rawCrop = await cropRawNiftiFile(rawLevel.path, rawLevel.layout, bbox)
    timer.mark('row-read')
    body = compressBuffer(rawCrop, encoding)
    timer.mark(`encode-${encoding}`)
  } catch (err) {
    if (err instanceof HttpError) throw err
    if (
      err &&
      typeof err === 'object' &&
      'status' in err &&
      typeof (err as { status?: unknown }).status === 'number'
    ) {
      throw err
    }
    source = 'memory-fallback'
    const { volume } = await registry.loadLevel(entry.id, levelIdx)
    timer.mark('load-level')
    const rawCrop = cropNiftiRaw(volume, bbox)
    body = compressBuffer(rawCrop, encoding)
    timer.mark(`crop-encode-${encoding}`)
  }

  setCropCache(cacheKey, body)
  return {
    buffer: body,
    cache: 'miss',
    source,
    serverTiming: timer.header(),
  }
}

function sendCroppedNifti(
  res: Response,
  entry: RegistryEntry,
  levelIdx: number,
  result: CropNiftiResponseResult,
  opts: { encoding: ContentEncoding; legacyGzip: boolean },
): void {
  const { encoding, legacyGzip } = opts
  if (legacyGzip) {
    res.set('Content-Type', NIFTI_GZIP_MEDIA_TYPE)
    res.set(
      'Content-Disposition',
      `inline; filename="${entry.id}_L${levelIdx}_crop.nii.gz"`,
    )
  } else {
    res.set('Content-Type', NIFTI_MEDIA_TYPE)
    if (encoding !== 'identity') {
      res.set('Content-Encoding', encoding)
    }
    res.set('Vary', 'Accept-Encoding, Accept')
    res.set(
      'Content-Disposition',
      `inline; filename="${entry.id}_L${levelIdx}_crop.nii"`,
    )
  }
  res.set('Content-Length', String(result.buffer.length))
  res.set('Cache-Control', 'public, max-age=3600')
  res.set('Server-Timing', result.serverTiming)
  res.set('X-Subvolume-Cache', result.cache)
  res.set('X-Subvolume-Source', result.source)
  res.send(result.buffer)
}

// Encode a chunk-aware subvolume read into NIfTI-1 bytes and serve. The
// underlying VolumeHandle has shape = bbox dims and affine already shifted
// so world coords align with the slab's origin. Used for native-pyramid
// sources (OME-Zarr) where row-read caching would force a full-level
// materialisation on disk first.
async function serveSubvolumeAsNifti(
  req: Request,
  res: Response,
  registry: Registry,
  entry: RegistryEntry,
  levelIdx: number,
  bbox: Bbox,
): Promise<void> {
  const { volume } = await registry.loadSubvolume(entry.id, levelIdx, bbox)
  const legacyGzip = legacyGzipWire(req)
  const encoding: ContentEncoding = legacyGzip
    ? 'gzip'
    : negotiateEncoding(req.headers['accept-encoding'] as string | undefined)
  const raw = encodeNiftiRaw({
    data: volume.data,
    shape: volume.shape,
    spacing: volume.spacing,
    dtype: volume.dtype,
    affine: volume.affine,
    sclSlope: volume.sclSlope,
    sclInter: volume.sclInter,
  })
  const body = compressBuffer(raw, encoding)
  if (legacyGzip) {
    res.set('Content-Type', NIFTI_GZIP_MEDIA_TYPE)
    res.set(
      'Content-Disposition',
      `inline; filename="${entry.id}_L${levelIdx}_crop.nii.gz"`,
    )
  } else {
    res.set('Content-Type', NIFTI_MEDIA_TYPE)
    if (encoding !== 'identity') {
      res.set('Content-Encoding', encoding)
    }
    res.set('Vary', 'Accept-Encoding')
    res.set(
      'Content-Disposition',
      `inline; filename="${entry.id}_L${levelIdx}_crop.nii"`,
    )
  }
  res.set('Content-Length', String(body.length))
  res.set('Cache-Control', 'public, max-age=3600')
  res.send(body)
}

// Encode the requested level's VolumeHandle into NIfTI-1 bytes and serve.
// Used for sources without a single backing file (OME-Zarr today). Honours
// the legacy `.nii.gz` URL contract and Accept-Encoding negotiation so the
// response looks identical to the streamed-file path used for NIfTI.
async function serveLevelAsNifti(
  req: Request,
  res: Response,
  registry: Registry,
  entry: RegistryEntry,
  levelIdx: number,
): Promise<void> {
  const { volume } = await registry.loadLevel(entry.id, levelIdx)
  const legacyGzip = legacyGzipWire(req)
  const encoding: ContentEncoding = legacyGzip
    ? 'gzip'
    : negotiateEncoding(req.headers['accept-encoding'] as string | undefined)
  const raw = encodeNiftiRaw({
    data: volume.data,
    shape: volume.shape,
    spacing: volume.spacing,
    dtype: volume.dtype,
    affine: volume.affine,
    sclSlope: volume.sclSlope,
    sclInter: volume.sclInter,
  })
  const body = compressBuffer(raw, encoding)
  if (legacyGzip) {
    res.set('Content-Type', NIFTI_GZIP_MEDIA_TYPE)
    res.set(
      'Content-Disposition',
      `inline; filename="${entry.id}_L${levelIdx}.nii.gz"`,
    )
  } else {
    res.set('Content-Type', NIFTI_MEDIA_TYPE)
    if (encoding !== 'identity') {
      res.set('Content-Encoding', encoding)
    }
    res.set('Vary', 'Accept-Encoding')
    res.set(
      'Content-Disposition',
      `inline; filename="${entry.id}_L${levelIdx}.nii"`,
    )
  }
  res.set('Content-Length', String(body.length))
  res.set('Cache-Control', 'public, max-age=3600')
  res.send(body)
}

async function streamSource(
  entry: RegistryEntry,
  res: Response,
): Promise<void> {
  const stat = await fsp.stat(entry.source)
  if (stat.isDirectory()) {
    throw new HttpError(
      501,
      `Direct download of ${entry.format} directories is not implemented in this POC. Use /volumes/${entry.id}/metadata or the IIIF Image API endpoints.`,
    )
  }
  const ext = path.extname(entry.source).toLowerCase()
  const contentType = pickContentType(entry.format, ext)
  res.set('Content-Type', contentType)
  res.set('Content-Length', String(stat.size))
  res.set('Cache-Control', 'public, max-age=3600')
  fs.createReadStream(entry.source).pipe(res)
}

function pickContentType(format: string, ext: string): string {
  if (format === 'nifti') {
    return ext === '.gz' ? 'application/x.nifti+gzip' : 'application/x.nifti'
  }
  if (format === 'nrrd') return 'application/octet-stream'
  return 'application/octet-stream'
}

function parseBbox(s: unknown): Bbox | null {
  if (!s) return null
  const parts = String(s).split(',').map(Number)
  if (parts.length !== 6 || parts.some((n) => !Number.isFinite(n))) {
    throw new HttpError(
      400,
      'Invalid bbox; expected six numbers: x0,y0,z0,x1,y1,z1',
    )
  }
  const [x0, y0, z0, x1, y1, z1] = parts.map(Math.round) as [
    number,
    number,
    number,
    number,
    number,
    number,
  ]
  return { x0, y0, z0, x1, y1, z1 }
}

export interface CropMeta {
  data: Uint8Array
  shape: Shape3
  spacing: import('../adapters/volumeHandle.ts').Vec3
  dtype: Dtype
  affine: Affine4x4 | null
  sclSlope: number
  sclInter: number
}

/**
 * Re-emit a NIfTI-1 file containing only the voxels within bbox.
 * Returns an uncompressed Buffer so callers can gzip or cache it as needed.
 *
 * The bbox is interpreted in *nominal* level voxel coordinates: when the
 * stored file was autocropped at pyramid build, this routine pads voxels
 * outside the stored region with the autocrop background value so the
 * response represents the nominal slab the caller asked for.
 */
export async function cropRawNiftiFile(
  filePath: string,
  layout: RawLevelLayout,
  bbox: Bbox,
): Promise<Buffer> {
  const meta = await cropRawNiftiData(filePath, layout, bbox)
  return encodeNiftiRaw(meta)
}

export async function cropRawNiftiData(
  filePath: string,
  layout: RawLevelLayout,
  bbox: Bbox,
): Promise<CropMeta> {
  const originalShape: Shape3 = layout.originalShape ?? layout.shape
  const cropOffset = layout.cropOffset ?? [0, 0, 0]
  const { x0, y0, z0, x1, y1, z1 } = normalizeBbox(bbox, originalShape)
  const cw = x1 - x0
  const ch = y1 - y0
  const cd = z1 - z0
  const voxelBytes = dtypeByteSize(layout.dtype)
  if (!voxelBytes) {
    throw new HttpError(501, `Unsupported dtype for row crop: ${layout.dtype}`)
  }

  const background = layout.background ?? 0
  const out = makeBackgroundFilledBuffer(
    cw * ch * cd,
    voxelBytes,
    layout.dtype,
    background,
  )

  const [storedSx, storedSy] = layout.shape
  const storedX0 = cropOffset[0]
  const storedY0 = cropOffset[1]
  const storedZ0 = cropOffset[2]
  const storedX1 = storedX0 + layout.shape[0]
  const storedY1 = storedY0 + layout.shape[1]
  const storedZ1 = storedZ0 + layout.shape[2]

  const ix0 = Math.max(x0, storedX0)
  const iy0 = Math.max(y0, storedY0)
  const iz0 = Math.max(z0, storedZ0)
  const ix1 = Math.min(x1, storedX1)
  const iy1 = Math.min(y1, storedY1)
  const iz1 = Math.min(z1, storedZ1)

  if (ix0 < ix1 && iy0 < iy1 && iz0 < iz1) {
    const sourceRowBytes = storedSx * voxelBytes
    const sourceSliceBytes = storedSx * storedSy * voxelBytes
    const rowBytes = (ix1 - ix0) * voxelBytes
    const voxOffset = Number(layout.voxOffset || 352)

    const handle = await fsp.open(filePath, 'r')
    try {
      for (let z = iz0; z < iz1; z++) {
        const fileZ = z - storedZ0
        for (let y = iy0; y < iy1; y++) {
          const fileY = y - storedY0
          const fileX = ix0 - storedX0
          const sourceOffset =
            voxOffset +
            fileZ * sourceSliceBytes +
            fileY * sourceRowBytes +
            fileX * voxelBytes
          const targetZ = z - z0
          const targetY = y - y0
          const targetX = ix0 - x0
          const targetOffset =
            (targetZ * cw * ch + targetY * cw + targetX) * voxelBytes
          const { bytesRead } = await handle.read(
            out,
            targetOffset,
            rowBytes,
            sourceOffset,
          )
          if (bytesRead !== rowBytes) {
            throw new Error(
              `Short NIfTI row read from ${filePath}: expected ${rowBytes}, got ${bytesRead}`,
            )
          }
        }
      }
    } finally {
      await handle.close()
    }
  }

  return {
    data: out,
    shape: [cw, ch, cd],
    spacing: layout.spacing,
    dtype: layout.dtype,
    affine: shiftedAffine(
      layout.affine,
      x0 - storedX0,
      y0 - storedY0,
      z0 - storedZ0,
    ),
    sclSlope: layout.sclSlope,
    sclInter: layout.sclInter,
  }
}

function makeBackgroundFilledBuffer(
  voxelCount: number,
  voxelBytes: number,
  dtype: Dtype,
  background: number,
): Buffer {
  const totalBytes = voxelCount * voxelBytes
  const buf = Buffer.allocUnsafe(totalBytes)
  if (!background) {
    buf.fill(0)
    return buf
  }
  if (
    dtype === 'uint8' ||
    dtype === 'int8' ||
    dtype === 'rgb24' ||
    dtype === 'rgba32'
  ) {
    buf.fill(background & 0xff)
    return buf
  }
  const Ctor = typedArrayForDtype(dtype)
  if (!Ctor) {
    buf.fill(0)
    return buf
  }
  const view = new Ctor(buf.buffer, buf.byteOffset, voxelCount)
  view.fill(background)
  return buf
}

type TypedScalarCtor =
  | Int16ArrayConstructor
  | Uint16ArrayConstructor
  | Int32ArrayConstructor
  | Uint32ArrayConstructor
  | Float32ArrayConstructor
  | Float64ArrayConstructor

function typedArrayForDtype(dtype: Dtype): TypedScalarCtor | null {
  switch (dtype) {
    case 'int16':
      return Int16Array
    case 'uint16':
      return Uint16Array
    case 'int32':
      return Int32Array
    case 'uint32':
      return Uint32Array
    case 'float32':
      return Float32Array
    case 'float64':
      return Float64Array
    default:
      return null
  }
}

export function cropNifti(volume: VolumeHandle, bbox: Bbox): Buffer {
  return encodeNifti(cropNiftiMeta(volume, bbox))
}

export function cropNiftiRaw(volume: VolumeHandle, bbox: Bbox): Buffer {
  return encodeNiftiRaw(cropNiftiMeta(volume, bbox))
}

function cropNiftiMeta(
  volume: VolumeHandle,
  bbox: Bbox,
): {
  data: import('../adapters/volumeHandle.ts').VoxelArray
  shape: Shape3
  spacing: import('../adapters/volumeHandle.ts').Vec3
  dtype: Dtype
  affine: Affine4x4 | null
  sclSlope: number
  sclInter: number
} {
  const v = volume
  const [sx, sy] = v.shape
  const { x0, y0, z0, x1, y1, z1 } = normalizeBbox(bbox, v.shape)
  const cw = x1 - x0
  const ch = y1 - y0
  const cd = z1 - z0
  const dataView = v.data
  const colorBytes = v.dtype === 'rgb24' ? 3 : v.dtype === 'rgba32' ? 4 : 0
  const TypedArrayCtor = dataView.constructor as {
    new (length: number): import('../adapters/volumeHandle.ts').VoxelArray
  }
  const elemsPerSliceRow = cw * (colorBytes || 1)
  const elemsPerSlice = elemsPerSliceRow * ch
  const out = new TypedArrayCtor(elemsPerSlice * cd)
  const srcRowStride = colorBytes || 1
  for (let z = 0; z < cd; z++) {
    for (let y = 0; y < ch; y++) {
      const srcVoxStart = x0 + (y0 + y) * sx + (z0 + z) * sx * sy
      const srcStart = srcVoxStart * srcRowStride
      const srcLen = cw * srcRowStride
      const dstStart = y * elemsPerSliceRow + z * elemsPerSlice
      ;(out as { set: (src: typeof dataView, off: number) => void }).set(
        dataView.subarray(srcStart, srcStart + srcLen) as typeof dataView,
        dstStart,
      )
    }
  }

  return {
    data: out,
    shape: [cw, ch, cd],
    spacing: v.spacing,
    dtype: v.dtype,
    affine: shiftedAffine(v.affine, x0, y0, z0),
    sclSlope: v.sclSlope,
    sclInter: v.sclInter,
  }
}

function normalizeBbox(bbox: Bbox, shape: Shape3): Bbox {
  const [sx, sy, sz] = shape
  const x0 = clamp(bbox.x0, 0, sx)
  const y0 = clamp(bbox.y0, 0, sy)
  const z0 = clamp(bbox.z0, 0, sz)
  const x1 = clamp(bbox.x1, x0, sx)
  const y1 = clamp(bbox.y1, y0, sy)
  const z1 = clamp(bbox.z1, z0, sz)
  if (x1 <= x0 || y1 <= y0 || z1 <= z0) {
    throw new HttpError(400, 'bbox produced an empty subvolume')
  }
  return { x0, y0, z0, x1, y1, z1 }
}

function shiftedAffine(
  affine: Affine4x4 | null,
  x0: number,
  y0: number,
  z0: number,
): Affine4x4 | null {
  if (!affine) return null
  const shifted = affine.map((row) => [...row]) as [
    [number, number, number, number],
    [number, number, number, number],
    [number, number, number, number],
    [number, number, number, number],
  ]
  shifted[0][3] += affine[0][0] * x0 + affine[0][1] * y0 + affine[0][2] * z0
  shifted[1][3] += affine[1][0] * x0 + affine[1][1] * y0 + affine[1][2] * z0
  shifted[2][3] += affine[2][0] * x0 + affine[2][1] * y0 + affine[2][2] * z0
  return shifted
}

function clamp(n: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, n))
}

function cropCacheKey(
  id: string,
  levelIdx: number,
  bbox: Bbox,
  encoding: ContentEncoding,
): string {
  return [
    id,
    levelIdx,
    bbox.x0,
    bbox.y0,
    bbox.z0,
    bbox.x1,
    bbox.y1,
    bbox.z1,
    encoding,
  ].join(':')
}

function getCropCache(key: string): Buffer | null {
  const buffer = cropResponseCache.get(key)
  if (!buffer) return null
  cropResponseCache.delete(key)
  cropResponseCache.set(key, buffer)
  return buffer
}

function setCropCache(key: string, buffer: Buffer): void {
  if (buffer.length > CROP_CACHE_MAX_ITEM_BYTES) return
  const existing = cropResponseCache.get(key)
  if (existing) {
    cropResponseCacheBytes -= existing.length
    cropResponseCache.delete(key)
  }
  cropResponseCache.set(key, buffer)
  cropResponseCacheBytes += buffer.length
  trimCropCache()
}

function trimCropCache(): void {
  while (
    cropResponseCache.size > CROP_CACHE_MAX_ENTRIES ||
    cropResponseCacheBytes > CROP_CACHE_MAX_BYTES
  ) {
    const oldestKey = cropResponseCache.keys().next().value
    if (!oldestKey) break
    const oldest = cropResponseCache.get(oldestKey)
    cropResponseCacheBytes -= oldest?.length ?? 0
    cropResponseCache.delete(oldestKey)
  }
}

interface ServerTimer {
  mark(name: string): void
  header(): string
}

function createServerTimer(): ServerTimer {
  const start = performance.now()
  let last = start
  const timings: Array<{ name: string; duration: number }> = []
  return {
    mark(name: string): void {
      const now = performance.now()
      timings.push({ name, duration: now - last })
      last = now
    },
    header(): string {
      const total = performance.now() - start
      return [...timings, { name: 'total', duration: total }]
        .map((item) => `${item.name};dur=${item.duration.toFixed(1)}`)
        .join(', ')
    },
  }
}
