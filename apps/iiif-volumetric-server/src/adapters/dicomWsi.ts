// DICOM Whole-Slide-Imaging (WSI) parsing helpers, kept separate from the
// adapter so the pure metadata + tile geometry is unit-testable without a
// DICOM file on disk.
//
// A WSI series is a set of single-frame-per-tile multi-frame instances, one
// instance per pyramid level (plus ancillary LABEL / OVERVIEW / THUMBNAIL
// images). Each VOLUME instance is a 2D tiled image:
//
//   - TotalPixelMatrixColumns/Rows (0048,0006 / 0048,0007) = level size in px.
//   - Columns/Rows (0028,0011 / 0028,0010)                 = tile size in px.
//   - NumberOfFrames (0028,0008)                           = tile count.
//   - DimensionOrganizationType (0020,9311) = TILED_FULL    = implicit raster
//     tile order (column index fastest, then row), so a tile's frame index is
//     pure arithmetic — no Per-Frame Functional Groups read needed.
//
// We model each level as a depth-1 RGB volume [W, H, 1] so the existing
// OME-Zarr streaming/pyramid machinery can serve it unchanged.

// dicom-parser tag keys are 'xggggeeee' (group+element, lowercase hex).
export const TAG = {
  imageType: 'x00080008',
  samplesPerPixel: 'x00280002',
  photometric: 'x00280004',
  rows: 'x00280010', // tile height
  columns: 'x00280011', // tile width
  bitsAllocated: 'x00280100',
  pixelSpacing: 'x00280030',
  numberOfFrames: 'x00280008',
  dimensionOrganizationType: 'x00209311',
  totalPixelMatrixColumns: 'x00480006', // level width
  totalPixelMatrixRows: 'x00480007', // level height
  transferSyntaxUid: 'x00020010',
  pixelData: 'x7fe00010',
} as const

// Whether a TransferSyntaxUID denotes compressed (encapsulated) pixel data,
// i.e. per-frame fragments needing a codec, rather than native pixels. The
// JPEG family is 1.2.840.10008.1.2.4.*, RLE is 1.2.840.10008.1.2.5; the
// uncompressed little/big-endian syntaxes (1.2.840.10008.1.2[.1|.2]) are not.
// We read this from the file-meta header so detection works even when the
// PixelData element itself has not been parsed (header-only metadata read).
export function isEncapsulatedTransferSyntax(uid: string): boolean {
  const u = uid.trim()
  return u.startsWith('1.2.840.10008.1.2.4') || u === '1.2.840.10008.1.2.5'
}

// Minimal subset of the dicom-parser DataSet surface we rely on.
export interface DicomElement {
  dataOffset: number
  length: number
}
export interface DicomDataSet {
  byteArray: Uint8Array
  elements: Record<string, DicomElement | undefined>
  uint16(tag: string): number | undefined
  uint32(tag: string): number | undefined
  intString(tag: string, index?: number): number | undefined
  floatString(tag: string, index?: number): number | undefined
  string(tag: string, index?: number): string | undefined
}

// Metadata for one WSI instance (one pyramid level or one ancillary image).
export interface WsiInstanceMeta {
  file: string
  width: number // TotalPixelMatrixColumns
  height: number // TotalPixelMatrixRows
  tileWidth: number // Columns
  tileHeight: number // Rows
  frames: number
  tiledFull: boolean
  encapsulated: boolean // true => per-frame JPEG; false => native pixels
  photometric: string // PhotometricInterpretation, e.g. RGB / YBR_FULL_422
  imageType: string // full ImageType string, e.g. DERIVED\PRIMARY\VOLUME\NONE
  flavor: WsiFlavor
  spacingMM: readonly [number, number] // [x (col), y (row)] in mm; [1,1] if absent
}

export type WsiFlavor = 'volume' | 'label' | 'overview' | 'thumbnail' | 'other'

// Whether jpeg-js should apply the YCbCr->RGB color transform when decoding a
// frame. DICOM-encapsulated JPEG frames carry the true color space in
// PhotometricInterpretation, which is authoritative: 'RGB' means the samples
// are already RGB (force the transform OFF — these CPTAC frames carry an Adobe
// APP14 marker that otherwise tricks the decoder into a green cast), while any
// 'YBR_*' value means luma/chroma that must be transformed back to RGB.
export function jpegColorTransform(photometric: string): boolean {
  return photometric.toUpperCase().startsWith('YBR')
}

export function classifyImageType(imageType: string): WsiFlavor {
  const t = imageType.toUpperCase()
  if (t.includes('LABEL')) return 'label'
  if (t.includes('OVERVIEW')) return 'overview'
  if (t.includes('THUMBNAIL')) return 'thumbnail'
  if (t.includes('VOLUME')) return 'volume'
  return 'other'
}

// Read the WSI metadata tags from an already-parsed dataset.
export function readInstanceMeta(
  file: string,
  ds: DicomDataSet,
): WsiInstanceMeta {
  const imageType = ds.string(TAG.imageType) ?? ''
  const width =
    ds.uint32(TAG.totalPixelMatrixColumns) ?? ds.uint16(TAG.columns) ?? 0
  const height = ds.uint32(TAG.totalPixelMatrixRows) ?? ds.uint16(TAG.rows) ?? 0
  const tileWidth = ds.uint16(TAG.columns) ?? width
  const tileHeight = ds.uint16(TAG.rows) ?? height
  const frames = ds.intString(TAG.numberOfFrames) ?? 1
  const org = (ds.string(TAG.dimensionOrganizationType) ?? '').toUpperCase()
  const encapsulated = isEncapsulatedTransferSyntax(
    ds.string(TAG.transferSyntaxUid) ?? '',
  )
  const sy = ds.floatString(TAG.pixelSpacing, 0) // row spacing (y)
  const sx = ds.floatString(TAG.pixelSpacing, 1) // column spacing (x)
  return {
    file,
    width,
    height,
    tileWidth,
    tileHeight,
    frames,
    tiledFull: org.includes('TILED_FULL'),
    encapsulated,
    photometric: (ds.string(TAG.photometric) ?? '').toUpperCase(),
    imageType,
    flavor: classifyImageType(imageType),
    spacingMM: [
      Number.isFinite(sx) && sx ? (sx as number) : 1,
      Number.isFinite(sy) && sy ? (sy as number) : 1,
    ],
  }
}

// One resolved pyramid level (index 0 = highest resolution).
export interface WsiLevel extends WsiInstanceMeta {
  level: number
}

// From all instances in a series, keep the VOLUME tiers, order them
// highest-resolution first, and number them 0..N-1. Ancillary images
// (label/overview/thumbnail) are dropped from the pyramid.
export function buildPyramid(instances: WsiInstanceMeta[]): WsiLevel[] {
  const volumes = instances.filter((m) => m.flavor === 'volume' && m.width > 0)
  volumes.sort((a, b) => b.width * b.height - a.width * a.height)
  return volumes.map((m, i) => ({ ...m, level: i }))
}

// Tiles across a level (column count of the tile grid). TILED_FULL frame
// order is column-fastest then row, so frame = row * tilesAcross + col.
export function tilesAcross(meta: {
  width: number
  tileWidth: number
}): number {
  return Math.ceil(meta.width / meta.tileWidth)
}

export function tilesDown(meta: {
  height: number
  tileHeight: number
}): number {
  return Math.ceil(meta.height / meta.tileHeight)
}

export function frameIndexForTile(
  meta: { width: number; tileWidth: number },
  tileCol: number,
  tileRow: number,
): number {
  return tileRow * tilesAcross(meta) + tileCol
}

// The half-open tile-grid range [colStart,colEnd)x[rowStart,rowEnd) covering a
// half-open pixel bbox [x0,x1)x[y0,y1) on the level. Inputs are clamped to the
// level extent so callers can pass loose bounds.
export interface TileRange {
  colStart: number
  colEnd: number
  rowStart: number
  rowEnd: number
}

export function tileRangeForBbox(
  meta: {
    width: number
    height: number
    tileWidth: number
    tileHeight: number
  },
  x0: number,
  y0: number,
  x1: number,
  y1: number,
): TileRange {
  const cx0 = Math.max(0, Math.min(x0, meta.width))
  const cy0 = Math.max(0, Math.min(y0, meta.height))
  const cx1 = Math.max(cx0, Math.min(x1, meta.width))
  const cy1 = Math.max(cy0, Math.min(y1, meta.height))
  return {
    colStart: Math.floor(cx0 / meta.tileWidth),
    colEnd: Math.max(
      Math.floor(cx0 / meta.tileWidth) + 1,
      Math.ceil(cx1 / meta.tileWidth),
    ),
    rowStart: Math.floor(cy0 / meta.tileHeight),
    rowEnd: Math.max(
      Math.floor(cy0 / meta.tileHeight) + 1,
      Math.ceil(cy1 / meta.tileHeight),
    ),
  }
}
