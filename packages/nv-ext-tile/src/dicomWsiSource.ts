import type {
  NVSlideAttribution,
  NVSlideLevelManifest,
  NVSlideManifest,
  NVSlideTileCodec,
  NVSlideTileManifest,
  SlideSourceHost,
  SlideTileSource,
} from '@niivue/niivue'
import { settleBy } from '@niivue/niivue'
import { cleanAttribution } from './attribution'
import { dicomLabToSrgb } from './cielab'
import {
  fileKeys,
  type InstanceCore,
  type SlideIndexLevel,
  type SlideIndexSlide,
} from './dicomIndex'
import type { DicomJsonSlide } from './dicomJson'
import {
  flipPlacement,
  levelCosines,
  levelMaps,
  orientGrid,
  slideOrientation,
  tileExtent,
} from './dicomOrientation'
import { anySignal } from './rangeFetch'

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

/** Looks up an instance's file among the indexed `files` (by its index key), checking it is unchanged. */
export function fileFor(
  files: readonly File[],
): (inst: { file: string; size: number; version: string }) => File {
  const keys = fileKeys(files)
  const byKey = new Map(files.map((f, i) => [keys[i], f]))
  return (inst) => {
    const file = byKey.get(inst.file)
    if (!file) throw new Error(`${inst.file} is not among the files`)
    if (file.size !== inst.size || String(file.lastModified) !== inst.version)
      throw new Error(`${inst.file} changed since it was indexed`)
    return file
  }
}

/** The slide's files in `slide.instances` order; `files` as indexed, in the same order. */
export const filesFor = (slide: SlideIndexSlide, files: readonly File[]) =>
  slide.instances.map(fileFor(files))

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

/** A frame's payload from its item-led span: its one fragment, or its fragments joined. */
export function joinFragments(span: Uint8Array, what: string): Uint8Array {
  const parts = fragmentsOf(span, what)
  if (parts.length === 1) return span.subarray(8) // one fragment: no copy
  const out = new Uint8Array(parts.reduce((sum, p) => sum + p.length, 0))
  let o = 0
  for (const p of parts) {
    out.set(span.subarray(p.offset, p.offset + p.length), o)
    o += p.length
  }
  return out
}

export interface DicomWsiSourceOptions {
  /** Credit for the slide, as `manifest.attribution`. */
  attribution?: NVSlideAttribution
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
  private readonly closed = new AbortController()

  constructor(
    readonly slide: SlideIndexSlide,
    files: readonly File[],
    options: DicomWsiSourceOptions = {},
  ) {
    this.files = filesFor(slide, files)
    this.maps = levelMaps(slide)
    this.manifest = manifestOf(slide, this.maps, { fileUrl: (i) => i.file })
    const attribution = cleanAttribution(options.attribution)
    if (attribution) this.manifest.attribution = attribution
  }

  bind(host: SlideSourceHost): void {
    this.host = host
  }

  /** A slice of `file`, abandoned on `signal` or dispose. */
  private read(
    file: File,
    start: number,
    end: number,
    signal?: AbortSignal,
  ): Promise<Uint8Array> {
    // File.slice reads take no signal: an abort stops the wait.
    return settleBy(
      anySignal(signal, this.closed.signal),
      file
        .slice(start, end)
        .arrayBuffer()
        .then((b) => new Uint8Array(b)),
    )
  }

  /** The optical path's ICC profile, read from the level-0 file; null without one. */
  async fetchIccProfile(signal?: AbortSignal): Promise<Uint8Array | null> {
    const icc = this.slide.iccProfile
    const l0 = this.slide.levels[0]
    if (!icc || !l0) return null
    const file = this.files[l0.instances[0] as number] as File
    return this.read(file, icc.offset, icc.offset + icc.length, signal)
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
    const span = await this.read(file, offset - 8, offset + length, signal)
    this.host?.addWireBytes(span.byteLength)
    return joinFragments(span, `${file.name} frame ${frames.frame[slot]}`)
  }

  /** Later reads, and reads in flight, reject AbortError. The files are the caller's. Idempotent. */
  dispose(): void {
    this.closed.abort()
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
  /** Each level's {@link levelMaps} entry. */
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
  // Each level turns by its own ImageOrientationSlide, so all share one displayed frame.
  const turns = slide.levels.map((level, index) => {
    const cosines = levelCosines(slide, level)
    const turn = slideOrientation(cosines)
    if (turn === null)
      console.warn(
        `level ${index} ImageOrientationSlide ${cosines?.join('\\')} is oblique; it is shown as stored`,
      )
    return turn ?? undefined
  })
  const g0 = orientGrid(l0, turns[0])
  const levels = slide.levels.map((level, index): NVSlideLevelManifest => {
    const o = turns[index]
    const inst = slide.instances[level.instances[0] as number] as I
    const codec = CODEC_BY_TRANSFER_SYNTAX[inst.transferSyntax]
    if (!codec)
      throw new Error(
        `transfer syntax ${inst.transferSyntax} cannot be decoded (JPEG, JPEG 2000 and JPEG-LS are supported)`,
      )
    // The index caps a level's grid, so this dense array is bounded.
    const g = orientGrid(level, o)
    const tiles: Array<NVSlideTileManifest | null> = Array.from(
      maps[index] as Int32Array,
      (slot, i) => {
        if (slot < 0) return null
        const x = i % g.columns
        const y = Math.floor(i / g.columns)
        return {
          x,
          y,
          ...tileExtent(g, o, x, y),
          frame: level.frames.frame[slot] as number,
        }
      },
    )
    const placement = flipPlacement(g, o, tiles)
    return {
      index,
      width: g.width,
      height: g.height,
      downsample: g0.width / g.width,
      tileWidth: g.tileWidth,
      tileHeight: g.tileHeight,
      columns: g.columns,
      rows: g.rows,
      codec,
      transferSyntaxUid: inst.transferSyntax,
      photometric: inst.photometric,
      bitsStored: inst.bitsStored,
      // Signed monochrome: NVSlide sign-extends the decoded samples (S7).
      ...(inst.signed && inst.photometric.startsWith('MONOCHROME')
        ? { sampleType: 'i16' as const }
        : {}),
      frames: level.frames.frame.length,
      // The index made one slide per optical path and focal plane.
      opticalPaths: 1,
      focalPlanes: 1,
      ...(level.sparse ? { sparse: true as const } : {}),
      ...(o ? { tileOrientation: o } : {}),
      ...(placement ? { placement } : {}),
      tiles,
    }
  })
  return {
    id: `${slide.series}/${slide.opticalPath}/${slide.focalPlane}`,
    name: slide.container ?? slide.series,
    format,
    width: g0.width,
    height: g0.height,
    // Row 0 at the top, as OpenSlide and the TIFF/DZI sources show a slide.
    displayYAxis: 'down',
    tileSize: g0.tileWidth,
    dtype: 'uint8',
    channels: 'encoded-rgb',
    // One grey channel, as NVSlide shows a monochrome slide without one (S1),
    // stating the rescale to data units.
    ...(inst0.photometric.startsWith('MONOCHROME')
      ? {
          channelInfo: [
            {
              name: 'gray',
              active: true,
              ...(inst0.rescale
                ? {
                    storedToValue: {
                      scale: inst0.rescale.slope,
                      offset: inst0.rescale.intercept,
                      quantized: false,
                    },
                  }
                : {}),
            },
          ],
        }
      : {}),
    ...(slide.pixelSpacingMM
      ? {
          pixelSpacingMM: turns[0]?.transpose
            ? [slide.pixelSpacingMM[1], slide.pixelSpacingMM[0]]
            : slide.pixelSpacingMM,
        }
      : {}),
    ...(inst0.absentLab
      ? {
          backgroundColor: [
            ...dicomLabToSrgb(inst0.absentLab).map((v) => v / 255),
            1,
          ] as [number, number, number, number],
        }
      : {}),
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
