// DICOM Whole-Slide-Imaging (WSI) adapter.
//
// A WSI series is exposed as a multiscale pyramid of depth-1 RGB volumes
// ([W, H, 1], dtype 'rgb24'), so the same pyramid + bbox-subvolume streaming
// path that serves OME-Zarr serves whole slides too. Each pyramid level is a
// separate DICOM instance whose tiles are per-frame baseline JPEGs in
// TILED_FULL raster order; a bbox read decodes only the covering tiles.
//
// Tile geometry + classification live in ./dicomWsi.ts (unit-tested). This
// file wires those to dicom-parser (frame extraction) and jpeg-js (decode),
// and implements the VolumeAdapter surface.

import fs from 'node:fs/promises'
import path from 'node:path'
import { decode as decodeJpeg } from 'jpeg-js'
import {
  buildPyramid,
  type DicomDataSet,
  type DicomElement,
  frameIndexForTile,
  jpegColorTransform,
  readInstanceMeta,
  TAG,
  tileRangeForBbox,
  type WsiLevel,
} from './dicomWsi.ts'
import type {
  AdapterContext,
  AdapterLevel,
  ProbeMeta,
  SubvolumeBbox,
  VolumeAdapter,
} from './nifti.ts'
import type { Vec3 } from './volumeHandle.ts'
import { VolumeHandle } from './volumeHandle.ts'

// Largest level we will materialise whole in loadLevel; bigger levels must be
// read through loadSubvolume (the base tier of a real slide is multi-GB).
const MAX_WHOLE_LEVEL_BYTES = 768 * 1024 * 1024

interface DicomParserModule {
  parseDicom(
    byteArray: Uint8Array,
    options?: { untilTag?: string },
  ): DicomDataSet
  createJPEGBasicOffsetTable(ds: DicomDataSet, el: DicomElement): number[]
  readEncapsulatedImageFrame(
    ds: DicomDataSet,
    el: DicomElement,
    frameIndex: number,
    basicOffsetTable?: number[],
  ): Uint8Array
}

let _parser: Promise<DicomParserModule> | null = null
function parser(): Promise<DicomParserModule> {
  if (!_parser) {
    _parser = import('dicom-parser' as string).then((m) => {
      const mod = m as { default?: DicomParserModule } & DicomParserModule
      return (mod.default ?? mod) as DicomParserModule
    })
  }
  return _parser
}

// A level's full buffer + parsed dataset + basic offset table, cached so
// repeated tile reads of the same level don't re-read/re-parse the file.
interface DecodableLevel {
  ds: DicomDataSet
  pixelEl: DicomElement
  bot: number[]
}

// Per-series cache: metadata pyramid + lazily-decoded level handles.
interface SeriesCache {
  levels: WsiLevel[]
  decodable: Map<number, Promise<DecodableLevel>>
}
const _seriesCache = new Map<string, Promise<SeriesCache>>()

async function dicomFilesIn(dirPath: string): Promise<string[]> {
  const items = await fs.readdir(dirPath)
  return items
    .filter((f) => /\.dcm$/i.test(f))
    .sort()
    .map((f) => path.join(dirPath, f))
}

// Parse only the metadata header (stop before PixelData) so probing a 422 MB
// base-level instance doesn't read the whole file.
async function readMetaForFile(file: string, p: DicomParserModule) {
  const buf = await readHeadChunk(file)
  const ds = p.parseDicom(buf, { untilTag: TAG.pixelData })
  return readInstanceMeta(file, ds)
}

// WSI metadata tags all precede PixelData and sit comfortably within the
// first chunk; read enough to be safe across vendors.
async function readHeadChunk(file: string): Promise<Uint8Array> {
  const handle = await fs.open(file, 'r')
  try {
    const size = (await handle.stat()).size
    const len = Math.min(size, 1024 * 1024)
    const out = new Uint8Array(len)
    await handle.read(out, 0, len, 0)
    return out
  } finally {
    await handle.close()
  }
}

async function seriesCacheFor(dirPath: string): Promise<SeriesCache> {
  let cached = _seriesCache.get(dirPath)
  if (!cached) {
    cached = (async () => {
      const p = await parser()
      const files = await dicomFilesIn(dirPath)
      if (files.length === 0) {
        throw new Error(`No .dcm files found in ${dirPath}`)
      }
      const metas = await Promise.all(files.map((f) => readMetaForFile(f, p)))
      const levels = buildPyramid(metas)
      if (levels.length === 0) {
        throw new Error(
          `No VOLUME pyramid tiers in ${dirPath} (found ${metas
            .map((m) => m.flavor)
            .join(', ')})`,
        )
      }
      return { levels, decodable: new Map() }
    })()
    _seriesCache.set(dirPath, cached)
  }
  return cached
}

function levelSpacing(level: WsiLevel): Vec3 {
  return [level.spacingMM[0], level.spacingMM[1], 1]
}

async function decodableFor(
  cache: SeriesCache,
  level: WsiLevel,
): Promise<DecodableLevel> {
  let entry = cache.decodable.get(level.level)
  if (!entry) {
    entry = (async () => {
      const p = await parser()
      const buf = await fs.readFile(level.file)
      const ds = p.parseDicom(
        new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength),
      )
      const pixelEl = ds.elements[TAG.pixelData]
      if (!pixelEl) throw new Error(`No PixelData in ${level.file}`)
      const bot = level.encapsulated
        ? p.createJPEGBasicOffsetTable(ds, pixelEl)
        : []
      return { ds, pixelEl, bot }
    })()
    cache.decodable.set(level.level, entry)
  }
  return entry
}

// Decode one tile to RGBA (tileWidth x tileHeight). Encapsulated levels read a
// per-frame JPEG; native levels (single-frame ancillary) read raw pixels.
async function decodeTile(
  dec: DecodableLevel,
  level: WsiLevel,
  frameIndex: number,
  p: DicomParserModule,
): Promise<Uint8Array> {
  if (level.encapsulated) {
    const encoded = p.readEncapsulatedImageFrame(
      dec.ds,
      dec.pixelEl,
      frameIndex,
      dec.bot,
    )
    const img = decodeJpeg(encoded, {
      useTArray: true,
      formatAsRGBA: true,
      colorTransform: jpegColorTransform(level.photometric),
    })
    return img.data
  }
  // Native RGB single-frame: slice straight from the byte array.
  const { tileWidth, tileHeight } = level
  const rgb = dec.ds.byteArray.subarray(
    dec.pixelEl.dataOffset,
    dec.pixelEl.dataOffset + tileWidth * tileHeight * 3,
  )
  const rgba = new Uint8Array(tileWidth * tileHeight * 4)
  for (let i = 0, j = 0; i < rgb.length; i += 3, j += 4) {
    rgba[j] = rgb[i] ?? 0
    rgba[j + 1] = rgb[i + 1] ?? 0
    rgba[j + 2] = rgb[i + 2] ?? 0
    rgba[j + 3] = 255
  }
  return rgba
}

// Copy the overlap of a decoded tile (RGBA, tileWidth x tileHeight, origin at
// tilePxX/tilePxY in level space) into an RGB destination of size dstW x dstH
// whose top-left is at dstOriginX/dstOriginY in level space.
function blitTile(
  dst: Uint8Array,
  dstW: number,
  dstH: number,
  dstOriginX: number,
  dstOriginY: number,
  tile: Uint8Array,
  tileW: number,
  tileH: number,
  tilePxX: number,
  tilePxY: number,
): void {
  const x0 = Math.max(dstOriginX, tilePxX)
  const y0 = Math.max(dstOriginY, tilePxY)
  const x1 = Math.min(dstOriginX + dstW, tilePxX + tileW)
  const y1 = Math.min(dstOriginY + dstH, tilePxY + tileH)
  for (let y = y0; y < y1; y++) {
    const tRow = (y - tilePxY) * tileW
    const dRow = (y - dstOriginY) * dstW
    for (let x = x0; x < x1; x++) {
      const t = (tRow + (x - tilePxX)) * 4
      const d = (dRow + (x - dstOriginX)) * 3
      dst[d] = tile[t] ?? 0
      dst[d + 1] = tile[t + 1] ?? 0
      dst[d + 2] = tile[t + 2] ?? 0
    }
  }
}

// Assemble an RGB region [x0,x1)x[y0,y1) of a level by decoding the covering
// TILED_FULL tiles. Used by both loadLevel (whole level) and loadSubvolume.
async function assembleRegion(
  cache: SeriesCache,
  level: WsiLevel,
  x0: number,
  y0: number,
  x1: number,
  y1: number,
): Promise<Uint8Array> {
  const p = await parser()
  const dec = await decodableFor(cache, level)
  const dstW = x1 - x0
  const dstH = y1 - y0
  const dst = new Uint8Array(dstW * dstH * 3)
  const range = tileRangeForBbox(level, x0, y0, x1, y1)
  for (let row = range.rowStart; row < range.rowEnd; row++) {
    for (let col = range.colStart; col < range.colEnd; col++) {
      const frame = frameIndexForTile(level, col, row)
      if (frame >= level.frames) continue
      const tile = await decodeTile(dec, level, frame, p)
      blitTile(
        dst,
        dstW,
        dstH,
        x0,
        y0,
        tile,
        level.tileWidth,
        level.tileHeight,
        col * level.tileWidth,
        row * level.tileHeight,
      )
    }
  }
  return dst
}

export const dicomAdapter: VolumeAdapter = {
  format: 'dicom-wsi',

  canHandle(p: string, { isDirectory }: AdapterContext): boolean {
    if (!isDirectory) return false
    return /(_dicom|\.dicom|dicom_series)$/i.test(p)
  },

  async probe(dirPath: string): Promise<ProbeMeta> {
    const cache = await seriesCacheFor(dirPath)
    const l0 = cache.levels[0] as WsiLevel
    return {
      shape: [l0.width, l0.height, 1],
      dtype: 'rgb24',
      spacing: levelSpacing(l0),
      affine: null,
    }
  },

  async probeLevels(dirPath: string): Promise<AdapterLevel[]> {
    const cache = await seriesCacheFor(dirPath)
    return cache.levels.map((l) => ({
      level: l.level,
      shape: [l.width, l.height, 1],
      spacing: levelSpacing(l),
      affine: null,
    }))
  },

  async load(dirPath: string): Promise<VolumeHandle> {
    // Default to the coarsest tier so a no-level request never tries to
    // materialise a multi-GB base level.
    const cache = await seriesCacheFor(dirPath)
    const coarsest = cache.levels[cache.levels.length - 1] as WsiLevel
    return this.loadLevel?.(dirPath, coarsest.level) as Promise<VolumeHandle>
  },

  async loadLevel(dirPath: string, levelIdx: number): Promise<VolumeHandle> {
    const cache = await seriesCacheFor(dirPath)
    const level = cache.levels.find((l) => l.level === levelIdx)
    if (!level) throw new Error(`Level ${levelIdx} not found in ${dirPath}`)
    const bytes = level.width * level.height * 3
    if (bytes > MAX_WHOLE_LEVEL_BYTES) {
      throw new Error(
        `Level ${levelIdx} (${level.width}x${level.height}, ${Math.round(
          bytes / 1024 / 1024,
        )} MB) exceeds the whole-level cap; read it via subvolume.`,
      )
    }
    const data = await assembleRegion(
      cache,
      level,
      0,
      0,
      level.width,
      level.height,
    )
    return new VolumeHandle({
      shape: [level.width, level.height, 1],
      spacing: levelSpacing(level),
      dtype: 'rgb24',
      data,
      metadata: { source: 'dicom-wsi', level: levelIdx, file: level.file },
    })
  },

  async loadSubvolume(
    dirPath: string,
    levelIdx: number,
    bbox: SubvolumeBbox,
  ): Promise<VolumeHandle> {
    const cache = await seriesCacheFor(dirPath)
    const level = cache.levels.find((l) => l.level === levelIdx)
    if (!level) throw new Error(`Level ${levelIdx} not found in ${dirPath}`)
    const x0 = Math.max(0, Math.min(bbox.x0, level.width))
    const y0 = Math.max(0, Math.min(bbox.y0, level.height))
    const x1 = Math.max(x0, Math.min(bbox.x1, level.width))
    const y1 = Math.max(y0, Math.min(bbox.y1, level.height))
    const data = await assembleRegion(cache, level, x0, y0, x1, y1)
    return new VolumeHandle({
      shape: [x1 - x0, y1 - y0, 1],
      spacing: levelSpacing(level),
      dtype: 'rgb24',
      data,
      metadata: { source: 'dicom-wsi', level: levelIdx },
    })
  },
}
