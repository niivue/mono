/**
 * Allen "volume-viewer" JSON + PNG atlas format.
 *
 * A dataset is one JSON sidecar plus N PNG atlases; each PNG is a row-major
 * grid of tiles (one tile per Z slice) that packs up to four independent image
 * channels into its R/G/B/A planes. See `docs/allen-atlas-format.md`.
 *
 * This module is the PURE half: parse/validate the sidecar and deinterleave one
 * channel out of already-decoded RGBA bytes. Fetching and PNG decoding live with
 * the caller so this stays testable without a canvas.
 */

/** One PNG atlas and the channel indices its R/G/B/A planes carry. */
export interface AllenAtlasImage {
  /** File name, resolved relative to the sidecar URL. */
  name: string
  /** Channel index per colour plane, in R, G, B, A order. */
  channels: number[]
}

/** Validated contents of an Allen atlas JSON sidecar. */
export interface AllenAtlasInfo {
  /** XY size of the ORIGINAL volume, before any downsample into the atlas. */
  width: number
  height: number
  /** Number of Z slices. */
  tiles: number
  /** Total channel count across every atlas. */
  channels: number
  /** Per-channel label, always `channels` entries. */
  channelNames: string[]
  /**
   * Per-channel RGB triplet, 0-255, indexed by channel; null where the sidecar
   * has no valid colour for that channel (the loader falls back to the shared
   * palette). May be shorter than `channels` when the sidecar's array is.
   */
  channelColors: (number[] | null)[]
  /** Tile grid of one atlas. */
  rows: number
  cols: number
  /** Stored XY size of one Z slice; may be smaller than `width`/`height`. */
  tileWidth: number
  tileHeight: number
  atlasWidth: number
  atlasHeight: number
  /** Voxel spacing of the ORIGINAL volume, in `spacingUnit`. */
  pixelSize: [number, number, number]
  spacingUnit: string
  /** Number of timepoints; 1 when the sidecar omits `times`. */
  times: number
  images: AllenAtlasImage[]
}

/** Raw sidecar JSON, before validation. Fields are snake_case as served. */
interface AllenAtlasJson {
  width?: unknown
  height?: unknown
  tiles?: unknown
  channels?: unknown
  channel_names?: unknown
  channel_colors?: unknown
  rows?: unknown
  cols?: unknown
  tile_width?: unknown
  tile_height?: unknown
  atlas_width?: unknown
  atlas_height?: unknown
  pixel_size_x?: unknown
  pixel_size_y?: unknown
  pixel_size_z?: unknown
  pixel_size_unit?: unknown
  times?: unknown
  images?: unknown
}

function positiveInt(value: unknown, field: string): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1) {
    throw new Error(`Allen atlas: '${field}' must be a positive integer`)
  }
  return value
}

function positiveNumber(value: unknown, fallback: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
    return fallback
  }
  return value
}

/**
 * Per-channel names, always `length` entries. A channel with no name in the
 * sidecar still needs a label to show in a layer list, so gaps and a missing
 * array alike fall back to a positional name.
 */
function stringArray(value: unknown, length: number): string[] {
  const names = Array.isArray(value) ? value : []
  return Array.from({ length }, (_unused, i) =>
    typeof names[i] === 'string' && names[i].length > 0
      ? names[i]
      : `Channel ${i}`,
  )
}

/**
 * Per-channel colours, kept POSITIONAL: entry i colours channel i, so a bad
 * entry becomes null (palette fallback for that one channel) rather than being
 * dropped, which would shift every later colour onto the wrong channel.
 */
function colorArray(value: unknown): (number[] | null)[] {
  if (!Array.isArray(value)) return []
  return value.map((entry) => {
    if (!Array.isArray(entry) || entry.length < 3) return null
    const rgb: number[] = []
    for (const c of entry.slice(0, 3)) {
      if (typeof c === 'number' && Number.isFinite(c) && c >= 0 && c <= 255) {
        rgb.push(c)
      }
    }
    return rgb.length === 3 ? rgb : null
  })
}

function parseImages(value: unknown, channels: number): AllenAtlasImage[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error("Allen atlas: 'images' must be a non-empty array")
  }
  const images: AllenAtlasImage[] = []
  for (const entry of value) {
    if (typeof entry !== 'object' || entry === null) {
      throw new Error('Allen atlas: every images[] entry must be an object')
    }
    const { name, channels: planes } = entry as {
      name?: unknown
      channels?: unknown
    }
    if (typeof name !== 'string' || name.length === 0) {
      throw new Error('Allen atlas: every images[] entry needs a name')
    }
    if (!Array.isArray(planes) || planes.length === 0) {
      throw new Error(`Allen atlas: '${name}' lists no channels`)
    }
    // A plane index outside the declared channel count would silently produce a
    // volume nothing references, so reject it rather than carry it forward.
    const mapped = planes.map((c) => {
      if (typeof c !== 'number' || !Number.isInteger(c) || c < 0) {
        throw new Error(`Allen atlas: '${name}' has a non-index channel entry`)
      }
      if (c >= channels) {
        throw new Error(
          `Allen atlas: '${name}' maps channel ${c}, past the declared ${channels}`,
        )
      }
      return c
    })
    if (mapped.length > 4) {
      throw new Error(`Allen atlas: '${name}' maps more than 4 colour planes`)
    }
    images.push({ name, channels: mapped })
  }
  return images
}

/**
 * Parse and validate an Allen atlas JSON sidecar.
 *
 * Accepts the object already parsed from JSON. Throws with a specific message on
 * anything that would produce a wrong volume rather than guessing, because a
 * silently mis-sized atlas decodes into plausible-looking garbage.
 */
export function parseAllenAtlasInfo(json: unknown): AllenAtlasInfo {
  if (typeof json !== 'object' || json === null) {
    throw new Error('Allen atlas: sidecar must be a JSON object')
  }
  const raw = json as AllenAtlasJson
  const channels = positiveInt(raw.channels, 'channels')
  const rows = positiveInt(raw.rows, 'rows')
  const cols = positiveInt(raw.cols, 'cols')
  const tiles = positiveInt(raw.tiles, 'tiles')
  if (tiles > rows * cols) {
    throw new Error(
      `Allen atlas: ${tiles} tiles do not fit a ${rows}x${cols} grid`,
    )
  }
  const tileWidth = positiveInt(raw.tile_width, 'tile_width')
  const tileHeight = positiveInt(raw.tile_height, 'tile_height')
  // atlas_width/height are redundant with tile size * grid; derive them when
  // absent and trust the derived value when the sidecar disagrees is NOT safe,
  // so disagreement is an error.
  const atlasWidth =
    raw.atlas_width === undefined
      ? tileWidth * cols
      : positiveInt(raw.atlas_width, 'atlas_width')
  const atlasHeight =
    raw.atlas_height === undefined
      ? tileHeight * rows
      : positiveInt(raw.atlas_height, 'atlas_height')
  if (atlasWidth !== tileWidth * cols || atlasHeight !== tileHeight * rows) {
    throw new Error(
      `Allen atlas: atlas ${atlasWidth}x${atlasHeight} does not match ` +
        `${cols}x${rows} tiles of ${tileWidth}x${tileHeight}`,
    )
  }
  const width = positiveInt(raw.width ?? tileWidth, 'width')
  const height = positiveInt(raw.height ?? tileHeight, 'height')
  return {
    width,
    height,
    tiles,
    channels,
    channelNames: stringArray(raw.channel_names, channels),
    channelColors: colorArray(raw.channel_colors),
    rows,
    cols,
    tileWidth,
    tileHeight,
    atlasWidth,
    atlasHeight,
    pixelSize: [
      positiveNumber(raw.pixel_size_x, 1),
      positiveNumber(raw.pixel_size_y, 1),
      positiveNumber(raw.pixel_size_z, 1),
    ],
    spacingUnit:
      typeof raw.pixel_size_unit === 'string' ? raw.pixel_size_unit : 'um',
    times: raw.times === undefined ? 1 : positiveInt(raw.times, 'times'),
    images: parseImages(raw.images, channels),
  }
}

/**
 * Voxel spacing of the STORED volume.
 *
 * The atlas may hold a downsampled slice (`tile_width` < `width`), while
 * `pixel_size_*` describes the original, so the stored spacing has to be scaled
 * by the same ratio or the volume comes out the wrong physical size. Z is
 * unscaled because slices are never decimated by the atlas layout.
 */
export function allenAtlasSpacing(
  info: AllenAtlasInfo,
): [number, number, number] {
  return [
    (info.pixelSize[0] * info.width) / info.tileWidth,
    (info.pixelSize[1] * info.height) / info.tileHeight,
    info.pixelSize[2],
  ]
}

/** Stored volume dims `[x, y, z]` of any single channel. */
export function allenAtlasVolumeDims(
  info: AllenAtlasInfo,
): [number, number, number] {
  return [info.tileWidth, info.tileHeight, info.tiles]
}

/**
 * Deinterleave one colour plane of a decoded atlas into a single-channel volume.
 *
 * `rgba` is the atlas as `getImageData().data` (4 bytes per pixel, row-major
 * over `info.atlasWidth`). `plane` is 0=R, 1=G, 2=B, 3=A. The result is
 * `tileWidth * tileHeight * tiles` bytes, z-major then y then x, which is the
 * layout NiiVue volumes already use.
 */
export function deinterleaveAllenAtlasPlane(
  rgba: Uint8Array | Uint8ClampedArray,
  info: AllenAtlasInfo,
  plane: number,
): Uint8Array {
  if (!Number.isInteger(plane) || plane < 0 || plane > 3) {
    throw new Error(`Allen atlas: colour plane ${plane} is out of range`)
  }
  const expected = info.atlasWidth * info.atlasHeight * 4
  if (rgba.length !== expected) {
    throw new Error(
      `Allen atlas: decoded atlas is ${rgba.length} bytes, expected ${expected}`,
    )
  }
  const { tileWidth, tileHeight, tiles, cols, atlasWidth } = info
  const out = new Uint8Array(tileWidth * tileHeight * tiles)
  let o = 0
  for (let t = 0; t < tiles; t++) {
    const tileX = (t % cols) * tileWidth
    const tileY = Math.floor(t / cols) * tileHeight
    for (let y = 0; y < tileHeight; y++) {
      let i = ((tileY + y) * atlasWidth + tileX) * 4 + plane
      for (let x = 0; x < tileWidth; x++) {
        out[o++] = rgba[i]
        i += 4
      }
    }
  }
  return out
}

/**
 * Resolve which atlas file and colour plane hold a given channel index.
 * Returns undefined when no atlas maps that channel.
 */
export function findAllenAtlasChannel(
  info: AllenAtlasInfo,
  channel: number,
): { image: AllenAtlasImage; plane: number } | undefined {
  for (const image of info.images) {
    const plane = image.channels.indexOf(channel)
    if (plane >= 0) return { image, plane }
  }
  return undefined
}
