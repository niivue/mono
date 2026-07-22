import type {
  NVSlideLevelManifest,
  NVSlideManifest,
  NVSlideTileManifest,
  SlideSourceHost,
  SlideTileSource,
} from '@niivue/niivue'
import { parseMultipartRelated } from './dicomWadoRs'
import type { OhifDisplaySet } from './ohif-types'

// DICOM transfer syntaxes -> NVSlide tile codecs. JPEG Baseline/Extended decode
// natively in the browser; JPEG-2000 needs a registered OpenJPEG decoder (v1
// does not ship one, so a JP2 WSI is out of scope for now).
const JPEG_TRANSFER_SYNTAXES = new Set([
  '1.2.840.10008.1.2.4.50', // JPEG Baseline (Process 1)
  '1.2.840.10008.1.2.4.51', // JPEG Extended (Process 2 & 4)
])

function num(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

// DICOM DS/IS values arrive as numbers or numeric strings depending on the data
// source; coerce either to a finite number.
function toNum(value: unknown): number | undefined {
  if (typeof value === 'number')
    return Number.isFinite(value) ? value : undefined
  if (typeof value === 'string') {
    const n = Number.parseFloat(value)
    return Number.isFinite(n) ? n : undefined
  }
  return undefined
}

function str(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

// First element of a value that may be a bare scalar or a (nested) array.
function first(value: unknown): unknown {
  return Array.isArray(value) ? value[0] : value
}

/**
 * Physical pixel spacing in millimetres as NVSlide expects it: `[x, y]` (column,
 * then row), for the given tier's pixel matrix. Prefers the per-frame
 * PixelSpacing carried in the (Shared/Per-frame) PixelMeasuresSequence, then a
 * top-level PixelSpacing, then falls back to ImagedVolumeWidth/Height divided by
 * the total pixel matrix. Returns undefined when no metric is present (the ruler
 * then measures in base slide pixels).
 *
 * DICOM PixelSpacing is [rowSpacing (dy), columnSpacing (dx)]; NVSlide wants
 * [dx, dy], so the pair is swapped. ImagedVolumeWidth is along columns (x) and
 * ImagedVolumeHeight along rows (y).
 */
function deriveSpacingMM(
  inst: Record<string, unknown>,
  matrixColumns: number,
  matrixRows: number,
): readonly [number, number] | undefined {
  const shared = first(inst.SharedFunctionalGroupsSequence) as
    | Record<string, unknown>
    | undefined
  const measures = first(shared?.PixelMeasuresSequence) as
    | Record<string, unknown>
    | undefined
  const pixelSpacing = measures?.PixelSpacing ?? inst.PixelSpacing
  if (Array.isArray(pixelSpacing)) {
    const dy = toNum(pixelSpacing[0])
    const dx = toNum(pixelSpacing[1])
    if (dx && dy && dx > 0 && dy > 0) return [dx, dy]
  }
  const volW = toNum(inst.ImagedVolumeWidth)
  const volH = toNum(inst.ImagedVolumeHeight)
  if (volW && volH && matrixColumns > 0 && matrixRows > 0) {
    return [volW / matrixColumns, volH / matrixRows]
  }
  return undefined
}

// A whole-slide pyramid level read from one OHIF SM instance.
interface WsiLevel {
  matrixColumns: number
  matrixRows: number
  tileColumns: number
  tileRows: number
  /** Frame base URL (`.../instances/{sop}/frames`); a tile fetch appends `/{n}`. */
  frameBaseUrl: string
  isJpeg: boolean
  /** Physical spacing `[dx, dy]` in mm for this tier, when the SM metadata carries it. */
  spacingMM?: readonly [number, number]
}

// A DICOM-WSI instance is a real pyramid tier only when its ImageType flavor is
// VOLUME (LABEL / OVERVIEW / THUMBNAIL are single-tile side images). When
// ImageType is absent, fall back to "genuinely tiled" (matrix bigger than a tile).
function isVolumeLevel(inst: Record<string, unknown>): boolean {
  const imageType = str(inst.ImageType)
  if (imageType) return imageType.includes('VOLUME')
  const matCols = num(inst.TotalPixelMatrixColumns) ?? 0
  const tileCols = num(inst.Columns) ?? 0
  const matRows = num(inst.TotalPixelMatrixRows) ?? 0
  const tileRows = num(inst.Rows) ?? 0
  return matCols > tileCols || matRows > tileRows
}

/** Extract the VOLUME pyramid levels from an SM display set, finest first. */
export function wsiVolumeLevels(ds: OhifDisplaySet): WsiLevel[] {
  const instances = ds.instances ?? []
  const imageIds = ds.imageIds ?? []
  const levels: WsiLevel[] = []
  instances.forEach((inst, i) => {
    // Prefer the per-instance imageId (populated by OHIF's data source) over the
    // display set's `imageIds` snapshot: a SOP-class handler may run before the
    // data source assigns imageIds, leaving that snapshot empty.
    const instImageId = (inst as { imageId?: unknown }).imageId
    const imageId = typeof instImageId === 'string' ? instImageId : imageIds[i]
    const matrixColumns = num(inst.TotalPixelMatrixColumns)
    const matrixRows = num(inst.TotalPixelMatrixRows)
    const tileColumns = num(inst.Columns)
    const tileRows = num(inst.Rows)
    if (
      !imageId ||
      !matrixColumns ||
      !matrixRows ||
      !tileColumns ||
      !tileRows ||
      !isVolumeLevel(inst)
    )
      return
    // '.../instances/{sop}/frames/1' -> '.../instances/{sop}/frames'
    const frameBaseUrl = imageId.replace(/^wadors:/, '').replace(/\/\d+$/, '')
    const transferSyntax =
      str(inst.TransferSyntaxUID) ?? str(inst.AvailableTransferSyntaxUID)
    levels.push({
      matrixColumns,
      matrixRows,
      tileColumns,
      tileRows,
      frameBaseUrl,
      // Default to JPEG when the syntax is unknown (v1 targets JPEG WSI).
      isJpeg: transferSyntax
        ? JPEG_TRANSFER_SYNTAXES.has(transferSyntax)
        : true,
      spacingMM: deriveSpacingMM(inst, matrixColumns, matrixRows),
    })
  })
  // Highest resolution first (index 0 = level 0), as the manifest expects.
  return levels.sort(
    (a, b) => b.matrixColumns * b.matrixRows - a.matrixColumns * a.matrixRows,
  )
}

/** Enumerate the row-major tile grid for one level (frame N = row*cols + col + 1). */
function levelTiles(level: WsiLevel): {
  columns: number
  rows: number
  tiles: NVSlideTileManifest[]
} {
  const columns = Math.ceil(level.matrixColumns / level.tileColumns)
  const rows = Math.ceil(level.matrixRows / level.tileRows)
  const tiles: NVSlideTileManifest[] = []
  for (let row = 0; row < rows; row++) {
    for (let col = 0; col < columns; col++) {
      // NVSlide expects `x`/`y` to be the COLUMN/ROW INDEX (it multiplies by the
      // level's tile size internally); `width`/`height` are the tile's pixel
      // extent, clipped at the matrix edge. The pixel offset is only used here to
      // compute that clipped size.
      const pixelX = col * level.tileColumns
      const pixelY = row * level.tileRows
      tiles.push({
        x: col,
        y: row,
        width: Math.min(level.tileColumns, level.matrixColumns - pixelX),
        height: Math.min(level.tileRows, level.matrixRows - pixelY),
        frame: row * columns + col + 1,
      })
    }
  }
  return { columns, rows, tiles }
}

export interface BuiltWsiManifest {
  manifest: NVSlideManifest
  /** Frame base URL by level.index (aligned with manifest.levels). */
  levelBaseUrls: string[]
  /** True when every kept level is JPEG (v1-renderable). */
  allJpeg: boolean
}

/**
 * Build an {@link NVSlideManifest} (+ per-level frame base URLs) from an OHIF
 * DICOM-WSI (SM) display set, or null when it has no VOLUME pyramid levels.
 */
export function buildWsiManifest(ds: OhifDisplaySet): BuiltWsiManifest | null {
  const volumeLevels = wsiVolumeLevels(ds)
  if (volumeLevels.length === 0) return null
  const level0 = volumeLevels[0]
  if (!level0) return null

  const levels: NVSlideLevelManifest[] = []
  const levelBaseUrls: string[] = []
  let allJpeg = true
  volumeLevels.forEach((level, index) => {
    const { columns, rows, tiles } = levelTiles(level)
    levels.push({
      index,
      width: level.matrixColumns,
      height: level.matrixRows,
      downsample: level0.matrixColumns / level.matrixColumns,
      tileWidth: level.tileColumns,
      tileHeight: level.tileRows,
      columns,
      rows,
      codec: level.isJpeg ? 'image/jpeg' : 'image/jp2',
      tiles,
    })
    levelBaseUrls[index] = level.frameBaseUrl
    if (!level.isJpeg) allJpeg = false
  })

  const manifest: NVSlideManifest = {
    id: str(ds.displaySetInstanceUID) ?? 'wsi',
    name: str(ds.SeriesDescription) ?? 'Whole-slide image',
    format: 'dicom-wsi-ohif',
    width: level0.matrixColumns,
    height: level0.matrixRows,
    displayYAxis: 'up',
    tileSize: level0.tileColumns,
    dtype: 'uint8',
    channels: 'encoded-rgb',
    // Physical spacing from the finest tier, so the ruler measures in real
    // microns / millimetres; omitted (ruler falls back to pixels) when absent.
    ...(level0.spacingMM ? { pixelSpacingMM: level0.spacingMM } : {}),
    levels,
  }
  return { manifest, levelBaseUrls, allJpeg }
}

/**
 * A live DICOM-WSI tile source: fetches encoded JPEG tiles on demand from a
 * DICOMweb server via WADO-RS `/frames/{n}`, one HTTP request per tile. NVSlide
 * owns the pyramid manifest, LOD, decoding and caching; this only supplies the
 * per-level frame base URLs + the encoded bytes.
 */
export class DicomWsiTileSource implements SlideTileSource {
  readonly manifest: NVSlideManifest
  private readonly levelBaseUrls: string[]
  private readonly headers: Record<string, string>

  constructor(built: BuiltWsiManifest, headers: Record<string, string> = {}) {
    this.manifest = built.manifest
    this.levelBaseUrls = built.levelBaseUrls
    this.headers = headers
  }

  // The source fetches absolute WADO-RS URLs itself, so it needs neither the
  // host's URL resolution nor its byte telemetry.
  bind(_host: SlideSourceHost): void {}

  async fetchTileBytes(
    level: NVSlideLevelManifest,
    tile: NVSlideTileManifest,
  ): Promise<Uint8Array> {
    const base = this.levelBaseUrls[level.index]
    if (!base) throw new Error(`no frame URL for WSI level ${level.index}`)
    if (tile.frame === undefined)
      throw new Error('WSI tile has no frame number')
    const response = await fetch(`${base}/${tile.frame}`, {
      headers: {
        Accept: 'multipart/related; type="image/jpeg"',
        ...this.headers,
      },
    })
    if (!response.ok) throw new Error(`WSI tile HTTP ${response.status}`)
    const contentType = response.headers.get('content-type') ?? ''
    const body = new Uint8Array(await response.arrayBuffer())
    const parts = parseMultipartRelated(body, contentType)
    const jpeg = parts[0]
    if (!jpeg || jpeg.length === 0) throw new Error('empty WSI tile body')
    return jpeg
  }
}
