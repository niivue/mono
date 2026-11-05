import type {
  NVSlideLevelManifest,
  NVSlideManifest,
  NVSlideTileCodec,
  NVSlideTileManifest,
  SlideSourceHost,
  SlideTileSource,
} from '@niivue/niivue'
import type { SlideIndexSlide } from './dicomIndex'

// DICOM transfer syntaxes -> NVSlide tile codecs (JPEG 2000 and JPEG-LS need a
// registered decoder, e.g. registerDcm2niixDecoders()).
const CODEC_BY_TRANSFER_SYNTAX: Record<string, NVSlideTileCodec> = {
  '1.2.840.10008.1.2.4.50': 'image/jpeg', // JPEG Baseline (Process 1)
  '1.2.840.10008.1.2.4.51': 'image/jpeg', // JPEG Extended (Process 2 & 4)
  '1.2.840.10008.1.2.4.80': 'image/jls', // JPEG-LS lossless
  '1.2.840.10008.1.2.4.81': 'image/jls', // JPEG-LS near-lossless
  '1.2.840.10008.1.2.4.90': 'image/jp2', // JPEG 2000 lossless
  '1.2.840.10008.1.2.4.91': 'image/jp2', // JPEG 2000
}

export const fileKey = (f: File): string => f.webkitRelativePath || f.name

/**
 * A SlideTileSource for one slide of a {@link SlideIndex}, reading each tile
 * from the local files with `File.slice`. Pass the same files that were indexed.
 */
export class DicomWsiSource implements SlideTileSource {
  readonly manifest: NVSlideManifest
  private readonly files: File[]
  private host: SlideSourceHost | null = null

  constructor(
    readonly slide: SlideIndexSlide,
    files: readonly File[],
  ) {
    const byKey = new Map(files.map((f) => [fileKey(f), f]))
    this.files = slide.instances.map((inst) => {
      const file = byKey.get(inst.file)
      if (!file) throw new Error(`${inst.file} is not among the files`)
      if (file.size !== inst.size || String(file.lastModified) !== inst.version)
        throw new Error(`${inst.file} changed since it was indexed`)
      return file
    })
    this.manifest = manifestOf(slide)
  }

  bind(host: SlideSourceHost): void {
    this.host = host
  }

  async fetchTileBytes(
    level: NVSlideLevelManifest,
    tile: NVSlideTileManifest,
    _label: string,
    signal?: AbortSignal,
  ): Promise<Uint8Array> {
    const frames = this.slide.levels[level.index]?.frames
    const slot = tile.frame ?? -1
    if (!frames || slot < 0 || slot >= frames.offset.length)
      throw new Error(`no frame for tile ${tile.x},${tile.y}`)
    const file = this.files[frames.instance[slot] as number] as File
    const offset = frames.offset[slot] as number
    const length = frames.length[slot] as number
    // Read the item header too: its tag proves the index still matches the file.
    const span = new Uint8Array(
      await file.slice(offset - 8, offset + length).arrayBuffer(),
    )
    signal?.throwIfAborted()
    this.host?.addWireBytes(span.byteLength)
    return payload(span, `${file.name} frame ${frames.frame[slot]}`)
  }
}

/** The frame's payload from its item-led span, stripping inner item headers. */
function payload(span: Uint8Array, what: string): Uint8Array {
  const dv = new DataView(span.buffer, span.byteOffset, span.byteLength)
  const isItem = (p: number): boolean =>
    p + 8 <= span.length &&
    dv.getUint16(p, true) === 0xfffe &&
    dv.getUint16(p + 2, true) === 0xe000
  if (!isItem(0)) throw new Error(`${what} is not where the index says`)
  const first = dv.getUint32(4, true)
  if (8 + first === span.length) return span.subarray(8) // one fragment: no copy
  const parts: Uint8Array[] = []
  for (let p = 0; p < span.length; ) {
    if (!isItem(p)) throw new Error(`${what}: no fragment item at byte ${p}`)
    const n = dv.getUint32(p + 4, true)
    if (p + 8 + n > span.length)
      throw new Error(`${what}: a fragment runs past its span`)
    parts.push(span.subarray(p + 8, p + 8 + n))
    p += 8 + n
  }
  const out = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0))
  let o = 0
  for (const part of parts) {
    out.set(part, o)
    o += part.length
  }
  return out
}

export function manifestOf(slide: SlideIndexSlide): NVSlideManifest {
  const l0 = slide.levels[0]
  if (!l0) throw new Error('the slide has no levels')
  const inst0 = slide.instances[l0.instances[0] as number]
  if (!inst0) throw new Error('the slide has no instances')
  const levels = slide.levels.map((level, index): NVSlideLevelManifest => {
    const inst = slide.instances[level.instances[0] as number] ?? inst0
    const codec = CODEC_BY_TRANSFER_SYNTAX[inst.transferSyntax]
    if (!codec)
      throw new Error(
        `transfer syntax ${inst.transferSyntax} cannot be decoded (JPEG, JPEG 2000 and JPEG-LS are supported)`,
      )
    const tiles: Array<NVSlideTileManifest | null> = Array.from(
      level.tile,
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
          frame: slot,
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
      frames: level.frames.offset.length,
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
    format: 'dicom-wsi-index-v1',
    width: l0.width,
    height: l0.height,
    // Row 0 at the top, as OpenSlide and the TIFF/DZI sources show a slide.
    displayYAxis: 'down',
    tileSize: l0.tileWidth,
    dtype: 'uint8',
    channels: 'encoded-rgb',
    ...(slide.pixelSpacingMM ? { pixelSpacingMM: slide.pixelSpacingMM } : {}),
    ...(slide.iccProfile
      ? { iccProfile: { url: inst0.file, ...slide.iccProfile } }
      : {}),
    levels,
  }
}
