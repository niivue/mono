import type {
  NVSlideLevelManifest,
  NVSlideManifest,
  NVSlideTileCodec,
  NVSlideTileManifest,
  SlideSourceHost,
  SlideTileSource,
} from '@niivue/niivue'
import {
  fileKey,
  type InstanceCore,
  type SlideIndexLevel,
  type SlideIndexSlide,
  tileMap,
} from './dicomIndex'
import type { DicomJsonSlide } from './dicomJson'

// DICOM transfer syntaxes -> NVSlide tile codecs (JPEG 2000 and JPEG-LS need a
// registered decoder, e.g. registerDcm2niixDecoders()).
export const CODEC_BY_TRANSFER_SYNTAX: Record<string, NVSlideTileCodec> = {
  '1.2.840.10008.1.2.4.50': 'image/jpeg', // JPEG Baseline (Process 1)
  '1.2.840.10008.1.2.4.51': 'image/jpeg', // JPEG Extended (Process 2 & 4)
  '1.2.840.10008.1.2.4.80': 'image/jls', // JPEG-LS lossless
  '1.2.840.10008.1.2.4.81': 'image/jls', // JPEG-LS near-lossless
  '1.2.840.10008.1.2.4.90': 'image/jp2', // JPEG 2000 lossless
  '1.2.840.10008.1.2.4.91': 'image/jp2', // JPEG 2000
}

/** The slide's files in `slide.instances` order; each must be the file that was indexed. */
export function filesFor(
  slide: SlideIndexSlide,
  files: readonly File[],
): File[] {
  const byKey = new Map(files.map((f) => [fileKey(f), f]))
  return slide.instances.map((inst) => {
    const file = byKey.get(inst.file)
    if (!file) throw new Error(`${inst.file} is not among the files`)
    if (file.size !== inst.size || String(file.lastModified) !== inst.version)
      throw new Error(`${inst.file} changed since it was indexed`)
    return file
  })
}

/**
 * The fragments of a frame's item-led span (as read from `offset - 8`): each
 * payload's offset within the span and its length. Throws when the span is not
 * whole items, e.g. when the file no longer matches the index.
 */
export function fragmentsOf(
  span: Uint8Array,
  what: string,
): { offset: number; length: number }[] {
  const dv = new DataView(span.buffer, span.byteOffset, span.byteLength)
  const fragments: { offset: number; length: number }[] = []
  for (let p = 0; p < span.length; ) {
    if (
      p + 8 > span.length ||
      dv.getUint16(p, true) !== 0xfffe ||
      dv.getUint16(p + 2, true) !== 0xe000
    )
      throw new Error(
        p === 0
          ? `${what} is not where the index says`
          : `${what}: no fragment item at byte ${p}`,
      )
    const n = dv.getUint32(p + 4, true)
    if (p + 8 + n > span.length)
      throw new Error(`${what}: a fragment runs past its span`)
    fragments.push({ offset: p + 8, length: n })
    p += 8 + n
  }
  if (!fragments.length) throw new Error(`${what}: an empty span`)
  return fragments
}

/**
 * A SlideTileSource for one slide of a {@link SlideIndex}, reading each tile
 * from the local files with `File.slice`. Pass the same files that were indexed.
 */
export class DicomWsiSource implements SlideTileSource {
  readonly manifest: NVSlideManifest
  private readonly files: File[]
  /** Each level's tile map (frame slot per tile), built here rather than at indexing. */
  private readonly maps: Int32Array[]
  private host: SlideSourceHost | null = null

  constructor(
    readonly slide: SlideIndexSlide,
    files: readonly File[],
  ) {
    this.files = filesFor(slide, files)
    this.maps = slide.levels.map(tileMap)
    this.manifest = manifestOf(slide, this.maps, { fileUrl: (i) => i.file })
  }

  bind(host: SlideSourceHost): void {
    this.host = host
  }

  /** The optical path's ICC profile, read from the level-0 file; null without one. */
  async fetchIccProfile(signal?: AbortSignal): Promise<Uint8Array | null> {
    const icc = this.slide.iccProfile
    const l0 = this.slide.levels[0]
    if (!icc || !l0) return null
    const file = this.files[l0.instances[0] as number] as File
    const bytes = new Uint8Array(
      await file.slice(icc.offset, icc.offset + icc.length).arrayBuffer(),
    )
    signal?.throwIfAborted()
    return bytes
  }

  async fetchTileBytes(
    level: NVSlideLevelManifest,
    tile: NVSlideTileManifest,
    _label: string,
    signal?: AbortSignal,
  ): Promise<Uint8Array> {
    const { frames } = this.slide.levels[level.index] as SlideIndexLevel
    const map = this.maps[level.index] as Int32Array
    const slot = map[tile.y * level.columns + tile.x] as number
    // Also catches a tile off the map (undefined).
    if (!(slot >= 0)) throw new Error(`no frame for tile ${tile.x},${tile.y}`)
    const file = this.files[frames.instance[slot] as number] as File
    const offset = frames.offset[slot] as number
    const length = frames.length[slot] as number
    // Read the item header too: its tag proves the index still matches the file.
    const span = new Uint8Array(
      await file.slice(offset - 8, offset + length).arrayBuffer(),
    )
    signal?.throwIfAborted()
    this.host?.addWireBytes(span.byteLength)
    const parts = fragmentsOf(span, `${file.name} frame ${frames.frame[slot]}`)
    if (parts.length === 1) return span.subarray(8) // one fragment: no copy
    const out = new Uint8Array(parts.reduce((sum, p) => sum + p.length, 0))
    let o = 0
    for (const p of parts) {
      out.set(span.subarray(p.offset, p.offset + p.length), o)
      o += p.length
    }
    return out
  }
}

/**
 * The slide's NVSlide manifest. Each tile's `frame` is its DICOM frame number;
 * `fileUrl` names an instance's file (the ICC profile's location).
 */
export function manifestOf<I extends InstanceCore>(
  /** A slide from indexDicomWsi or indexDicomWsiMetadata. */
  slide: Omit<DicomJsonSlide, 'instances' | 'iccProfile'> & {
    instances: I[]
    iccProfile?: { offset?: number; length?: number; colorSpace?: string }
  },
  /** Each level's {@link tileMap}. */
  maps: readonly Int32Array[],
  {
    format = 'dicom-wsi-index-v1',
    fileUrl,
  }: {
    format?: string
    fileUrl: (instance: I) => string
  },
): NVSlideManifest {
  const l0 = slide.levels[0]
  if (!l0) throw new Error('the slide has no levels')
  // The index puts each level's first instance in slide.instances.
  const inst0 = slide.instances[l0.instances[0] as number] as I
  const levels = slide.levels.map((level, index): NVSlideLevelManifest => {
    const inst = slide.instances[level.instances[0] as number] as I
    const codec = CODEC_BY_TRANSFER_SYNTAX[inst.transferSyntax]
    if (!codec)
      throw new Error(
        `transfer syntax ${inst.transferSyntax} cannot be decoded (JPEG, JPEG 2000 and JPEG-LS are supported)`,
      )
    // The index caps a level's grid, so this dense array is bounded.
    const tiles: Array<NVSlideTileManifest | null> = Array.from(
      maps[index] as Int32Array,
      (slot, i) => {
        if (slot < 0) return null
        const x = i % level.columns
        const y = Math.floor(i / level.columns)
        return {
          x,
          y,
          width: Math.min(level.tileWidth, level.width - x * level.tileWidth),
          height: Math.min(
            level.tileHeight,
            level.height - y * level.tileHeight,
          ),
          frame: level.frames.frame[slot] as number,
        }
      },
    )
    return {
      index,
      width: level.width,
      height: level.height,
      downsample: l0.width / level.width,
      tileWidth: level.tileWidth,
      tileHeight: level.tileHeight,
      columns: level.columns,
      rows: level.rows,
      codec,
      transferSyntaxUid: inst.transferSyntax,
      photometric: inst.photometric,
      bitsStored: inst.bitsStored,
      frames: level.frames.frame.length,
      // The index made one slide per optical path and focal plane.
      opticalPaths: 1,
      focalPlanes: 1,
      ...(level.sparse ? { sparse: true as const } : {}),
      tiles,
    }
  })
  return {
    id: `${slide.series}/${slide.opticalPath}/${slide.focalPlane}`,
    name: slide.container ?? slide.series,
    format,
    width: l0.width,
    height: l0.height,
    // Row 0 at the top, as OpenSlide and the TIFF/DZI sources show a slide.
    displayYAxis: 'down',
    tileSize: l0.tileWidth,
    dtype: 'uint8',
    channels: 'encoded-rgb',
    ...(slide.pixelSpacingMM ? { pixelSpacingMM: slide.pixelSpacingMM } : {}),
    ...(slide.iccProfile
      ? {
          iccProfile: {
            url: fileUrl(inst0),
            offset: slide.iccProfile.offset,
            length: slide.iccProfile.length,
            colorSpace: slide.iccProfile.colorSpace,
          },
        }
      : {}),
    levels,
  }
}
