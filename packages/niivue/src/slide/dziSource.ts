import type {
  NVSlideLevelManifest,
  NVSlideManifest,
  NVSlideTileManifest,
  SlideSourceHost,
  SlideTileSource,
} from './NVSlide'

// DeepZoom (DZI) descriptor: <Image TileSize Overlap Format><Size Width Height/>.
export interface DziDescriptor {
  tileSize: number
  overlap: number
  format: string
  width: number
  height: number
}

// Parse a .dzi descriptor. Regex-based (the schema is a flat two-element XML), so
// it works in both the browser and Node without a DOMParser.
export function parseDziDescriptor(xml: string): DziDescriptor {
  const attr = (name: string): string | null => {
    const m = new RegExp(`${name}\\s*=\\s*"([^"]*)"`).exec(xml)
    return m ? (m[1] ?? null) : null
  }
  const tileSize = Number(attr('TileSize'))
  const overlap = Number(attr('Overlap') ?? '0')
  const format = (attr('Format') ?? 'jpeg').toLowerCase()
  const width = Number(attr('Width'))
  const height = Number(attr('Height'))
  if (
    !Number.isFinite(tileSize) ||
    tileSize < 1 ||
    !Number.isFinite(width) ||
    !Number.isFinite(height) ||
    width < 1 ||
    height < 1
  ) {
    throw new Error('Invalid .dzi descriptor (missing TileSize/Width/Height)')
  }
  return { tileSize, overlap, format, width, height }
}

// Build the NVSlide pyramid manifest from a DZI descriptor. DZI levels run
// 0 (1x1) .. maxLevel (full res); we emit finest-first (index 0 = maxLevel) down
// to the first single-tile level, and remember each index's DZI level so the
// source can address tiles at `{base}_files/{dziLevel}/{col}_{row}.{ext}`.
export function buildDziManifest(
  desc: DziDescriptor,
  id: string,
): { manifest: NVSlideManifest; dziLevelForIndex: number[] } {
  const { tileSize, overlap, width, height } = desc
  // overlap > 0: DziSource decodes + crops each tile to its core, returning
  // raw RGBA; overlap 0: the JPEG bytes pass straight to the image/jpeg decoder.
  const codec = overlap > 0 ? 'raw-rgba' : 'image/jpeg'
  const maxLevel = Math.ceil(Math.log2(Math.max(width, height)))
  const levels: NVSlideLevelManifest[] = []
  const dziLevelForIndex: number[] = []
  let index = 0
  for (let d = maxLevel; d >= 0; d--) {
    const scale = 2 ** (maxLevel - d)
    const levelW = Math.max(1, Math.ceil(width / scale))
    const levelH = Math.max(1, Math.ceil(height / scale))
    const columns = Math.ceil(levelW / tileSize)
    const rows = Math.ceil(levelH / tileSize)
    const tiles: NVSlideTileManifest[] = []
    for (let row = 0; row < rows; row++) {
      for (let col = 0; col < columns; col++) {
        tiles.push({
          x: col,
          y: row,
          width: Math.min(tileSize, levelW - col * tileSize),
          height: Math.min(tileSize, levelH - row * tileSize),
        })
      }
    }
    levels.push({
      index,
      width: levelW,
      height: levelH,
      downsample: width / levelW,
      tileWidth: tileSize,
      tileHeight: tileSize,
      columns,
      rows,
      codec,
      tiles,
    })
    dziLevelForIndex.push(d)
    index++
    if (columns <= 1 && rows <= 1) break // stop at the first single-tile level
  }
  const manifest: NVSlideManifest = {
    id,
    name: `${id} (DZI)`,
    format: 'dzi',
    width,
    height,
    tileSize,
    dtype: 'uint8',
    channels: 'encoded-rgb',
    displayYAxis: 'down',
    levels,
  }
  return { manifest, dziLevelForIndex }
}

/**
 * DeepZoom (DZI) slide source. Each tile is a separate image fetched by URL
 * (`{base}_files/{dziLevel}/{col}_{row}.{ext}`) with a plain GET — unlike the
 * byte-range manifest source. For overlap > 0 (the common case, e.g.
 * OpenSeadragon pyramids) the decoded tile is cropped to its grid-aligned core
 * and returned as raw RGBA, so the tile placement model (grid-aligned) stays
 * correct; for overlap 0 the JPEG bytes pass straight through.
 */
export class DziSource implements SlideTileSource {
  readonly manifest: NVSlideManifest
  private host: SlideSourceHost | null = null
  private readonly tilesBase: string
  private readonly ext: string
  private readonly overlap: number
  private readonly dziLevelForIndex: number[]

  private constructor(
    manifest: NVSlideManifest,
    tilesBase: string,
    ext: string,
    overlap: number,
    dziLevelForIndex: number[],
  ) {
    this.manifest = manifest
    this.tilesBase = tilesBase
    this.ext = ext
    this.overlap = overlap
    this.dziLevelForIndex = dziLevelForIndex
  }

  static async fromUrl(dziUrl: string, id?: string): Promise<DziSource> {
    const response = await fetch(dziUrl)
    if (!response.ok) {
      throw new Error(`DZI descriptor HTTP ${response.status}`)
    }
    const xml = await response.text()
    const desc = parseDziDescriptor(xml)
    const name = id ?? dziUrl.replace(/^.*\//, '').replace(/\.dzi$/i, '')
    const { manifest, dziLevelForIndex } = buildDziManifest(desc, name)
    // "<base>.dzi" -> tiles live under "<base>_files/".
    const tilesBase = dziUrl.replace(/\.dzi$/i, '_files')
    const ext = desc.format === 'png' ? 'png' : 'jpg'
    return new DziSource(
      manifest,
      tilesBase,
      ext,
      desc.overlap,
      dziLevelForIndex,
    )
  }

  bind(host: SlideSourceHost): void {
    this.host = host
  }

  async fetchTileBytes(
    level: NVSlideLevelManifest,
    tile: NVSlideTileManifest,
    label: string,
  ): Promise<Uint8Array> {
    const dziLevel = this.dziLevelForIndex[level.index] ?? 0
    const url = `${this.tilesBase}/${dziLevel}/${tile.x}_${tile.y}.${this.ext}`
    this.host?.pushRangeEvent({ label, status: 'pending' })
    const response = await fetch(url)
    if (!response.ok) {
      this.host?.updateRangeEvent(label, 'failed')
      throw new Error(`HTTP ${response.status} for ${url}`)
    }
    const bytes = new Uint8Array(await response.arrayBuffer())
    this.host?.addWireBytes(bytes.byteLength)
    this.host?.updateRangeEvent(label, 'hit')
    if (this.overlap <= 0) return bytes
    return this.cropTileCore(bytes, tile)
  }

  // Decode the (overlapped) tile image and crop to its grid-aligned core, so the
  // grid-aligned renderer places it correctly. Interior tiles carry `overlap`
  // extra pixels on their left/top; the core is tile.width x tile.height at that
  // offset. Returns raw RGBA (level.codec is raw-rgba when overlap > 0).
  private async cropTileCore(
    bytes: Uint8Array,
    tile: NVSlideTileManifest,
  ): Promise<Uint8Array> {
    const offsetX = tile.x > 0 ? this.overlap : 0
    const offsetY = tile.y > 0 ? this.overlap : 0
    const blob = new Blob([bytes.slice()])
    const bitmap = await createImageBitmap(blob)
    try {
      const canvas = new OffscreenCanvas(tile.width, tile.height)
      const ctx = canvas.getContext('2d')
      if (!ctx) throw new Error('OffscreenCanvas 2D context unavailable')
      ctx.drawImage(bitmap, -offsetX, -offsetY)
      const image = ctx.getImageData(0, 0, tile.width, tile.height)
      return new Uint8Array(image.data.buffer)
    } finally {
      bitmap.close()
    }
  }
}
