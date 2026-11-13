import type {
  BlockedSourceOptions,
  GeoTIFF,
  Pool,
  RemoteSourceOptions,
} from '@niivue/geotiff-rs'
import {
  addDecoder,
  BaseClient,
  BaseDecoder,
  BaseResponse,
  fromCustomClient,
  GeoTIFFImage,
} from '@niivue/geotiff-rs'
import type {
  NVSlideAttribution,
  NVSlideChannelInfo,
  NVSlideLevelManifest,
  NVSlideManifest,
  NVSlidePlaneAxes,
  NVSlidePlaneIndex,
  NVSlideTileManifest,
  NVSlideTileSamples,
  NVSlideWindow,
  SlideFetch,
  SlidePlaneCapable,
  SlideSourceHost,
  SlideTileSource,
} from '@niivue/niivue'
import {
  decodeXmlEntities,
  parseOmeXml,
  readCapped,
  settleBy,
} from '@niivue/niivue'
import { cleanAttribution } from './attribution'
import {
  grayInto,
  MAX_DEFAULT_VISIBLE,
  MAX_TILE_SIZE,
  MAX_TILES,
  planeArray,
  type Quantize,
  quantizeRange,
  storedToValue,
  storedWindow,
} from './channelDisplay'
import { sharedDcm2niixDecoders } from './dcm2niixDecoders'
import { sampleLevel } from './levelSample'
import {
  anySignal,
  rangeReplyError,
  refuseReply,
  slideFetch,
} from './rangeFetch'
import { ARGOS_TAG, argosStack } from './vendor/argos'
import { leicaComposition, leicaRegions } from './vendor/leica'
import {
  NDPI_MCU_STARTS,
  NDPI_SOURCELENS,
  type NdpiJpeg,
  ndpiGrid,
  ndpiJpeg,
  ndpiTileJpeg,
} from './vendor/ndpi'
import { type PhilipsLevel, philipsLevels } from './vendor/philips'
import { attrs as rawAttrs, type VendorPlacement } from './vendor/placement'
import { trestleOverlaps, trestlePlacement } from './vendor/trestle'
import {
  isVentanaXmp,
  type VentanaSeam,
  ventanaPlacement,
} from './vendor/ventana'

export interface TiffSlideOptions {
  /** Manifest id; defaults to the file name. */
  id?: string
  /** geotiff decoder pool (web workers). Owned by the caller; omit to decode on the main thread. */
  pool?: Pool
  /** Focal plane: OME-TIFF default 0, Argos stack default the middle. */
  z?: number
  /** OME-TIFF timepoint; default 0. */
  t?: number
  /** Credit for the image, kept as `manifest.attribution` (text; `url` only when http(s)). */
  attribution?: NVSlideAttribution
  /**
   * Vendor tile placement (`level.placement`): Ventana BIF joints, Trestle
   * overlaps, Leica SCN regions side by side. Default true; false opens
   * these files as their storage grid.
   */
  placement?: boolean
}

export interface TiffSlideUrlOptions extends TiffSlideOptions {
  /**
   * Custom fetch, e.g. one that adds auth headers; globalThis.fetch by default.
   * Called as `(url, init)` for every Range read. A redirect is reused only on
   * the URL's origin then (the default fetch reuses any).
   */
  fetch?: SlideFetch
  /** Aborts opening, e.g. when a newer open supersedes this one. */
  signal?: AbortSignal
}

// geotiff block cache: coalesces the 4/8-byte TileOffsets/TileByteCounts reads
// and IFD parsing into 64 KiB Range requests (geotiff 2.x's default). A tile
// read costs its byte count rounded out to block boundaries. fromCustomClient
// forwards blockSize, though its typings only declare RemoteSourceOptions.
const SOURCE_OPTIONS: RemoteSourceOptions & BlockedSourceOptions = {
  blockSize: 65536,
}

// Hostile-file bounds (with MAX_TILE_SIZE, MAX_TILES): a self-referencing
// IFD chain or a 2^32-pixel level must fail fast instead of looping or
// allocating per-tile objects.
const MAX_IMAGES = 64
// One NDPI read (a tile's intervals, or a strip without restart markers): far
// past a real tile, short of an allocation a crafted offset could force.
const MAX_NDPI_READ = 64 * 1024 * 1024
// geotiff walks the IFD chain up to a plane, a read per IFD.
const MAX_PLANE_IFD = 4096

class RangeResponse extends BaseResponse {
  constructor(
    private readonly response: Response,
    /** The body, read and checked by RangeClient. */
    private readonly data: ArrayBuffer,
  ) {
    super()
  }
  get status(): number {
    return this.response.status
  }
  getHeader(name: string): string | undefined {
    return this.response.headers.get(name) ?? undefined
  }
  async getData(): Promise<ArrayBuffer> {
    return this.data
  }
}

// Every geotiff read goes through here: counts wire bytes and refuses a server
// that ignores Range, so a multi-GB slide is never downloaded whole by accident.
class RangeClient extends BaseClient {
  private host: SlideSourceHost | null = null
  // Opening reads the header and IFDs before bind(); report them on bind.
  private unboundBytes = 0
  private unboundHits = 0
  // A redirect target (e.g. a signed CDN URL), reused for later reads: one
  // round trip, not two (HF resolve: 133 to 28 ms median). The canonical URL
  // stays the identity and is read again when the target fails.
  private resolved: string | null = null
  // Targets that failed in a row; at 2 (e.g. CORS on the CDN) none is learned again.
  private failures = 0
  // The file size, from the first exposed Content-Range.
  private size: number | undefined
  // geotiff's block cache swallows client errors into "Request failed"; keep
  // the last one so opening a slide can report the real cause.
  lastError: unknown = null
  // geotiff passes a signal only to the header and tile fetches, so every read
  // also listens to this: the caller's open signal while opening, then the
  // source's lifetime, which cancels deferred metadata reads (an ICC profile)
  // on dispose.
  openSignal: AbortSignal | null = null
  constructor(
    url: string,
    private readonly fetchImpl: SlideFetch,
    /** A caller's fetch may add credentials: reuse only a same-origin redirect. */
    private readonly customFetch: boolean,
  ) {
    super(url)
  }
  bind(host: SlideSourceHost): void {
    this.host = host
    host.addWireBytes(this.unboundBytes)
    for (let i = 0; i < this.unboundHits; i++) host.rangeHit()
  }
  async request(options: RequestInit = {}): Promise<BaseResponse> {
    try {
      return await this.rangeRequest(options)
    } catch (error) {
      this.lastError = error
      throw error
    }
  }
  private reusable(target: string): boolean {
    if (this.failures >= 2) return false
    if (!this.customFetch) return true
    try {
      return new URL(target).origin === new URL(this.url).origin
    } catch {
      return false
    }
  }
  private async fetchRange(init: RequestInit): Promise<Response> {
    const resolved = this.resolved
    if (resolved) {
      try {
        const response = await this.fetchImpl(resolved, init)
        if (response.ok) {
          this.failures = 0
          return response
        }
        await response.body?.cancel()
      } catch (error) {
        if (init.signal?.aborted) throw error
      }
      // Any failure (an expired signed URL, CORS): the canonical URL, once.
      // Reads already in flight on a target another read dropped do not count.
      if (this.resolved === resolved) {
        this.resolved = null
        this.failures++
      }
    }
    const response = await this.fetchImpl(this.url, init)
    if (
      response.redirected &&
      response.url &&
      response.url !== this.url &&
      this.reusable(response.url)
    )
      this.resolved = response.url
    return response
  }
  private count(n: number): void {
    if (this.host) this.host.addWireBytes(n)
    else this.unboundBytes += n
  }
  private async rangeRequest(options: RequestInit): Promise<BaseResponse> {
    const range = new Headers(options.headers).get('Range') ?? ''
    // geotiff reads closed ranges. The reply's length is known from an exposed
    // Content-Range (or the size one stated); else (cross-origin, unexposed)
    // only bounded: the last block may run past EOF.
    const [, a, b] = /^bytes=(\d+)-(\d+)$/.exec(range) ?? []
    const start = Number(a)
    const max = Number(b) - start + 1
    const bound = b === undefined ? Number.POSITIVE_INFINITY : max
    // Chromium can hand back a truncated body for a partly cached range: a
    // reply that is short or misplaced is read once more past the cache.
    for (let attempt = 0; ; attempt++) {
      const response = await this.fetchRange({
        headers: options.headers,
        signal: anySignal(options.signal, this.openSignal),
        ...(attempt ? { cache: 'no-store' as const } : {}),
      })
      // Strict: every geotiff read is ranged, so any 200 is refused.
      const bad = rangeReplyError(response, range)
      if (bad?.kind === 'whole-file')
        await refuseReply(
          response,
          `${this.url}: server ignored the HTTP Range request (200, not 206). ` +
            'nv-ext-tile/tiff needs Range support (and CORS allowing Range) to stream a slide. Open a local copy with TiffSlideSource.fromGeoTIFF(await fromBlob(file)).',
        )
      if (!response.ok)
        await refuseReply(response, `${this.url}: HTTP ${response.status}`)
      if (bad?.kind === 'misplaced') {
        const message = `${this.url}: server sent Content-Range starting at ${bad.got}, requested ${bad.want}`
        if (attempt) await refuseReply(response, message)
        await response.body?.cancel()
        continue
      }
      const cr = /^bytes (\d+)-(\d+)\/(\d+|\*)$/.exec(
        response.headers.get('Content-Range') ?? '',
      )
      const total = cr?.[3] && cr[3] !== '*' ? Number(cr[3]) : undefined
      const size = this.size ?? total
      const exact =
        b === undefined
          ? undefined
          : size !== undefined
            ? Math.min(Number(b), size - 1) - start + 1
            : cr
              ? Number(cr[2]) - Number(cr[1]) + 1
              : undefined
      // Refused past the range, by Content-Length or else while streamed.
      const body = await readCapped(response, bound)
      const data =
        body.byteLength === body.buffer.byteLength
          ? (body.buffer as ArrayBuffer)
          : body.slice().buffer
      const n = data.byteLength
      this.count(n)
      if (exact !== undefined ? n !== exact : n > bound) {
        if (!attempt) continue
        throw new Error(
          `${this.url} ${range}: expected ${exact ?? `at most ${bound}`} bytes, received ${n}`,
        )
      }
      // Learned only from a reply that proved itself.
      if (total !== undefined) this.size ??= total
      if (this.host) this.host.rangeHit()
      else this.unboundHits++
      return new RangeResponse(response, data)
    }
  }
}

// The main IFD chain from `first`. Walked here: geotiff's getImageCount loops
// forever on a cycle.
async function chainImages(
  tiff: GeoTIFF,
  first: GeoTIFFImage,
): Promise<GeoTIFFImage[]> {
  const images = [first]
  let last = first
  while (last.fileDirectory.nextIFDByteOffset && images.length < MAX_IMAGES) {
    last = await tiff.getImage(images.length)
    images.push(last)
  }
  const base = images
    .filter((img) => img.isTiled)
    .reduce<GeoTIFFImage | null>(
      (a, b) => (a && a.getWidth() >= b.getWidth() ? a : b),
      null,
    )
  // Only padded images pay the read: an ordinary pyramid opens as before.
  await Promise.all(
    images.map(async (img) => {
      if (!base || !img.isTiled || !paddedDownsample(base, img)) return
      const desc = await img.fileDirectory.loadValue('ImageDescription')
      if (typeof desc === 'string' && desc.startsWith('level='))
        iscanLevels.add(img)
    }),
  )
  return images
}

async function pyramidImages(
  tiff: GeoTIFF,
  first: GeoTIFFImage,
  chain: boolean,
  philips?: PhilipsLevel[] | null,
): Promise<TiffLevel[]> {
  // OME-TIFF (bioformats 6+) keeps the pyramid of each plane in SubIFDs; the
  // main IFD chain then holds channels/z/t planes, not levels.
  const subIfds = (await first.fileDirectory.loadValue('SubIFDs')) as
    | ArrayLike<number | bigint>
    | undefined
  if (subIfds && subIfds.length > 0) {
    const subs = await Promise.all(
      Array.from(subIfds)
        .slice(0, MAX_IMAGES)
        .map(async (offset) => {
          const ifd = await tiff.parser.parseFileDirectoryAt(Number(offset))
          return new GeoTIFFImage(
            ifd,
            tiff.littleEndian,
            tiff.cache,
            tiff.source,
          )
        }),
    )
    return pyramidLevels([first, ...subs])
  }
  if (!chain) return pyramidLevels([first])
  // SVS / plain pyramidal TIFF: levels are the tiled images of the main chain.
  // The stripped ones (SVS thumbnail, label, macro) are not levels.
  return pyramidLevels(await chainImages(tiff, first), philips)
}

type Dim = 'C' | 'Z' | 'T'

// The first Image's Pixels in OME-XML: plane counts, order and channels.
interface OmePixels {
  sizes: Record<Dim, number>
  /** DimensionOrder after XY, fastest first, e.g. 'CZT'. */
  order: Dim[]
  channels: { name?: string; rgb?: readonly [number, number, number] }[]
  /** Attributes, plus `elsewhere` (a file name) when another file holds them. */
  tiffData: Record<string, string>[]
  /** PhysicalSizeZ in µm, when stated. */
  zStepUm?: number
}

// Core's parseOmeXml reads sizes, order and channels; only the TiffData IFD map
// is read here (regex, not DOMParser: absent in Bun and workers).
const attrs = (tag: string) =>
  Object.fromEntries(
    Object.entries(rawAttrs(tag)).map(([k, v]) => [k, decodeXmlEntities(v)]),
  )
function omePixels(xml: string, samplesPerPixel: number): OmePixels | null {
  const info = parseOmeXml(xml)
  const pixels =
    /<(?:\w+:)?Pixels\b[^>]*?(?:\/>|>[\s\S]*?<\/(?:\w+:)?Pixels>)/.exec(
      xml,
    )?.[0]
  if (!info || !pixels) return null
  // Multi-file sets: a TiffData whose UUID is not this file's (the root
  // OME UUID) numbers IFDs of another file.
  const self = attrs(/<(?:\w+:)?OME\b[^>]*>/.exec(xml)?.[0] ?? '').UUID
  const tiffData = Array.from(
    pixels.matchAll(
      /<(?:\w+:)?TiffData\b[^>]*?(?:\/>|>[\s\S]*?<\/(?:\w+:)?TiffData>)/g,
    ),
    ([block]) => {
      const uuid = /<(?:\w+:)?UUID\b([^>]*)>([^<]*)</.exec(block)
      const other = uuid && self && uuid[2]?.trim() !== self
      return {
        ...attrs(/^[^>]*>/.exec(block)?.[0] ?? ''),
        ...(other
          ? { elsewhere: attrs(uuid[1] ?? '').FileName ?? uuid[2] ?? '' }
          : {}),
      }
    },
  )
  const channels = info.channels.map(({ name, color }) => ({
    ...(name ? { name } : {}),
    ...(color ? { rgb: color } : {}),
  }))
  const zStepUm = info.spacingUm[2]
  return {
    ...(zStepUm > 0 ? { zStepUm } : {}),
    // SizeC counts samples: an RGB plane is one Channel of 3.
    sizes: {
      C: channels.length || Math.ceil(info.sizeC / samplesPerPixel),
      Z: info.sizeZ,
      T: info.sizeT,
    },
    order: [...info.dimensionOrder.slice(2)] as Dim[],
    channels,
    tiffData,
  }
}

// The main-chain IFD of plane `at`: by DimensionOrder, through TiffData when
// listed (IFD + offset from its First C/Z/T over PlaneCount planes).
function planeIfd(ome: OmePixels, at: Record<Dim, number>): number {
  const linear = (pos: Record<Dim, number>) => {
    let index = 0
    let stride = 1
    for (const d of ome.order) {
      index += pos[d] * stride
      stride *= ome.sizes[d]
    }
    return index
  }
  const plane = linear(at)
  let ifd = ome.tiffData.length ? Number.NaN : plane
  for (const td of ome.tiffData) {
    const num = (v?: string) => Number(v ?? 0)
    const start = linear({
      C: num(td.FirstC),
      Z: num(td.FirstZ),
      T: num(td.FirstT),
    })
    // OME schema: PlaneCount defaults to 1 with an IFD, else to every plane.
    const count =
      td.PlaneCount !== undefined
        ? num(td.PlaneCount)
        : td.IFD !== undefined
          ? 1
          : Number.POSITIVE_INFINITY
    if (plane >= start && plane < start + count) {
      if (td.elsewhere !== undefined)
        throw new Error(
          `OME-TIFF: plane C${at.C} Z${at.Z} T${at.T} is in ${td.elsewhere || 'another file'}; open that file (multi-file sets are not supported)`,
        )
      ifd = num(td.IFD) + plane - start
      break
    }
  }
  if (!(Number.isInteger(ifd) && ifd >= 0 && ifd < MAX_PLANE_IFD))
    throw new Error(
      `OME-TIFF: plane C${at.C} Z${at.Z} T${at.T} maps to IFD ${ifd}, not in 0-${MAX_PLANE_IFD - 1}`,
    )
  return ifd
}

const checkIndex = (what: string, value: number, count: number) => {
  if (!(Number.isInteger(value) && value >= 0 && value < count))
    throw new Error(`TIFF: ${what} ${value} is not in 0-${count - 1}`)
}

// How a one-sample image's samples reach NVSlide (contract numeric rules):
// u8/u16/i16/f32 native (int8 widens to i16, float16 to f32), wider types
// quantized to uint16 over a data range.
interface SampleKind {
  bitsStored: 8 | 16 | 32
  sampleType?: 'i16' | 'f32'
  quantize: boolean
  float: boolean
}

function sampleKind(img: GeoTIFFImage): SampleKind {
  const bits = img.getBitsPerSample(0)
  const format = img.getSampleFormat(0)
  const float = format === 3
  if (float && bits <= 32)
    return { bitsStored: 32, sampleType: 'f32', quantize: false, float }
  if (format === 2 && bits <= 16)
    return { bitsStored: 16, sampleType: 'i16', quantize: false, float }
  if (!float && format !== 2 && bits <= 16)
    return { bitsStored: bits <= 8 ? 8 : 16, quantize: false, float }
  return { bitsStored: 16, quantize: true, float }
}

// Grey samples: one channel served as raw-gray tiles, or several (multi-channel
// OME-TIFF) served as sample planes through fetchTileSamples.
interface TiffChannels {
  kind: SampleKind
  info: NVSlideChannelInfo[]
  /** Per channel: its quantization, null for native samples, undefined until a hidden channel's range is read. */
  quantize: (Quantize | null | undefined)[]
}

interface TiffOpened {
  /** One pyramid per channel plane; a single one unless multi-channel. */
  pyramids: TiffLevel[][]
  channels: TiffChannels | null
  plane: NVSlidePlaneIndex
  /** An OME z/t stack: its axes, and how to open another plane's pyramids. */
  axes?: NVSlidePlaneAxes
  openPlane?: (p: NVSlidePlaneIndex) => Promise<TiffLevel[][]>
  /** Vendor tile placement (`TiffSlideOptions.placement`). */
  placement?: VendorPlacement
  placementReport?: TiffPlacementReport
}

/** What placement resolved: a grid fallback's warning, or Ventana's per-seam residuals. */
export interface TiffPlacementReport {
  warning?: string
  notice?: string
  seams?: VentanaSeam[]
}

const planeKey = ({ z, t }: NVSlidePlaneIndex) => `${z},${t}`

// Every channel plane's pyramid: levels, tiles, samples, dtype, photometric.
function planeShape(pyramids: TiffLevel[][]): string[] {
  return pyramids.map((levels) =>
    levels
      .map(
        ({ img: i, width, height }) =>
          `${width}x${height} ${i.getTileWidth()}x${i.getTileHeight()} ${i.getSamplesPerPixel()} ${i.getBitsPerSample(0)} ${i.getSampleFormat(0)} ${i.fileDirectory.getValue('PhotometricInterpretation')}`,
      )
      .join(),
  )
}

async function openTiff(
  tiff: GeoTIFF,
  options: TiffSlideOptions,
  signal?: AbortSignal,
): Promise<TiffOpened> {
  const { z = 0, t = 0, pool } = options
  const first = await tiff.getImage(0)
  const dir = first.fileDirectory
  const xml = dir.hasTag(270) ? await dir.loadValue('ImageDescription') : null
  const description = typeof xml === 'string' ? xml : ''
  if (dir.hasTag(ARGOS_TAG)) {
    const stack = await argosOpened(tiff, first, options.z)
    if (stack) return stack
  }
  if (dir.hasTag(NDPI_SOURCELENS) && !first.isTiled)
    return {
      pyramids: [await ndpiLevels(tiff, first)],
      channels: null,
      plane: { z: 0, t: 0 },
    }
  const ome =
    typeof xml === 'string' && /<(?:\w+:)?OME\b/.test(xml)
      ? omePixels(xml, first.getSamplesPerPixel())
      : null
  const sizes = ome?.sizes ?? { C: 1, Z: 1, T: 1 }
  checkIndex('z', z, sizes.Z)
  checkIndex('t', t, sizes.T)
  const plane = { z, t }
  // One plane at IFD 0 keeps the IFD-chain walk (pyramids that chain their
  // levels); TiffData may map the plane past unused IFDs.
  if (
    !ome ||
    (sizes.C * sizes.Z * sizes.T === 1 &&
      planeIfd(ome, { C: 0, Z: 0, T: 0 }) === 0)
  ) {
    const placed =
      options.placement !== false
        ? await placedPyramid(tiff, first, description)
        : null
    const pyramids = [
      placed?.levels ??
        (await pyramidImages(tiff, first, true, philipsLevels(description))),
    ]
    return {
      pyramids,
      channels: await grayChannels(pyramids, ome, pool, signal),
      plane,
      ...(placed?.placement ? { placement: placed.placement } : {}),
      ...(placed?.report ? { placementReport: placed.report } : {}),
    }
  }
  // Several RGB channels: the first, in colour.
  const multi = sizes.C > 1 && first.getSamplesPerPixel() === 1
  const openPlane = (p: NVSlidePlaneIndex) =>
    Promise.all(
      Array.from({ length: multi ? sizes.C : 1 }, async (_, c) => {
        const img = await tiff.getImage(planeIfd(ome, { C: c, Z: p.z, T: p.t }))
        return pyramidImages(tiff, img, false)
      }),
    )
  const pyramids = await openPlane(plane)
  // The level manifest has one shape and photometric for every channel plane.
  const shapes = planeShape(pyramids)
  const photometric = (levels?: TiffLevel[]) =>
    levels
      ?.map(({ img }) =>
        img.fileDirectory.getValue('PhotometricInterpretation'),
      )
      .join()
  for (const [c, shape] of shapes.entries())
    if (shape !== shapes[0])
      throw new Error(
        photometric(pyramids[c]) !== photometric(pyramids[0])
          ? `OME-TIFF: channel ${c}'s PhotometricInterpretation differs from channel 0's`
          : `OME-TIFF: channel ${c}'s pyramid differs from channel 0's`,
      )
  const { zStepUm } = ome
  return {
    pyramids,
    channels: await grayChannels(pyramids, ome, pool, signal),
    plane,
    ...(sizes.Z * sizes.T > 1
      ? {
          axes: {
            z: sizes.Z,
            t: sizes.T,
            ...(zStepUm
              ? {
                  zPositionsUm: Array.from(
                    { length: sizes.Z },
                    (_, k) => k * zStepUm,
                  ),
                }
              : {}),
          },
          openPlane,
        }
      : {}),
  }
}

/**
 * A one-sample (grey) slide's channels: one for a WhiteIsZero/BlackIsZero
 * image, one per plane of a multi-channel OME-TIFF; null for RGB or palette.
 * Visible channels get their window here; hidden ones on first show.
 */
async function grayChannels(
  pyramids: TiffLevel[][],
  ome: OmePixels | null,
  pool: Pool | undefined,
  signal?: AbortSignal,
): Promise<TiffChannels | null> {
  const img0 = pyramids[0]?.[0]?.img
  if (!img0 || img0.getSamplesPerPixel() !== 1) return null
  const photometric = img0.fileDirectory.getValue('PhotometricInterpretation')
  if (pyramids.length === 1 && photometric !== 0 && photometric !== 1)
    return null
  const kind = sampleKind(img0)
  const info: NVSlideChannelInfo[] = []
  const quantize: TiffChannels['quantize'] = []
  // One channel at a time bounds open's reads in flight and sample memory.
  for (const [c, levels] of pyramids.entries()) {
    const { name, rgb } = ome?.channels[c] ?? {}
    // OME-XML has no omero `active`: every channel is, the first few visible.
    const active = c < MAX_DEFAULT_VISIBLE
    const channel: NVSlideChannelInfo = {
      name: name ?? (pyramids.length === 1 ? 'gray' : `Channel ${c + 1}`),
      ...(rgb ? { rgb } : {}),
      active,
    }
    if (active) {
      // One u8 grey image keeps its stored look (0 to 2^bits-1, as an RGB
      // bitmap showed it: a 4-bit 15 is white), with no open-time sample reads.
      const display =
        pyramids.length === 1 && kind.bitsStored === 8 && !kind.sampleType
          ? {
              window: { calMin: 0, calMax: 2 ** img0.getBitsPerSample(0) - 1 },
              q: null,
            }
          : await channelDisplay(levels, kind, pool, signal)
      Object.assign(channel, displayPatch(display))
      quantize.push(display.q)
    } else quantize.push(undefined)
    info.push(channel)
  }
  return { kind, info, quantize }
}

interface ChannelDisplay {
  window: NVSlideWindow
  q: Quantize | null
}

// As ZarrSlideSource: the 2-98% range of a coarsest-level sample; quantized
// kinds over its min..max.
async function channelDisplay(
  levels: TiffLevel[],
  kind: SampleKind,
  pool: Pool | undefined,
  signal?: AbortSignal,
): Promise<ChannelDisplay> {
  const coarse = levels.at(-1)
  if (!coarse) throw new Error('TIFF has no tiled pyramid levels')
  const [p2, p98, min, max] = await dataRange(coarse, pool, signal)
  if (kind.sampleType) {
    // Native signed/float samples: the window in data units, never degenerate.
    const window =
      p98 > p2
        ? { calMin: p2, calMax: p98 }
        : Number.isFinite(p2)
          ? { calMin: p2 - 0.5, calMax: p2 + 0.5 }
          : { calMin: 0, calMax: 1 }
    return { window, q: null }
  }
  const q = kind.quantize ? quantizeRange(min, max, kind.float).quantize : null
  return {
    window: storedWindow(q, p2, p98, kind.bitsStored === 8 ? 8 : 16),
    q,
  }
}

const displayPatch = ({
  window,
  q,
}: ChannelDisplay): Pick<NVSlideChannelInfo, 'window' | 'storedToValue'> => ({
  window,
  ...(q ? { storedToValue: storedToValue(q) } : {}),
})

// The sample grid of `level` (levelSample.ts).
function dataRange(
  level: TiffLevel,
  pool: Pool | undefined,
  signal?: AbortSignal,
): Promise<[number, number, number, number]> {
  return sampleLevel(
    level.width,
    level.height,
    level.img.getTileWidth(),
    level.img.getTileHeight(),
    async ([y0, y1], [x0, x1]) => {
      const [data] = await level.img.readRasters({
        window: [x0, y0, x1, y1],
        samples: [0],
        pool,
        signal,
      })
      return data as ArrayLike<number>
    },
  )
}

// A pyramid level: its image and the slide area it holds, which is smaller
// than the image when the writer padded it to whole tiles.
interface TiffLevel {
  img: GeoTIFFImage
  width: number
  height: number
  downsample: number
  /** Leica regions side by side in one storage grid (placement). */
  regions?: TiffRegion[]
  /** NDPI: one JPEG strip read as virtual tiles of restart intervals. */
  ndpi?: NdpiLevel
}

interface NdpiLevel extends ReturnType<typeof ndpiGrid> {
  strip: number
  count: number
  /** Null: a strip without restart intervals, served whole as one tile. */
  jpeg: NdpiJpeg | null
  starts?: Promise<ArrayLike<number>>
}

interface TiffRegion {
  img: GeoTIFFImage
  colStart: number
  columns: number
  rows: number
  width: number
  height: number
}

// The region image holding grid tile (x, y) of `level`, and the tile there.
function regionTile(level: TiffLevel, x: number, y: number) {
  const r = level.regions?.find(
    (r) => x >= r.colStart && x < r.colStart + r.columns && y < r.rows,
  )
  return r && { ...r, x: x - r.colStart, y }
}

const padToTiles = (n: number, downsample: number, tile: number) =>
  Math.ceil(Math.ceil(n / downsample) / tile) * tile

// Ventana iScan pads each level to whole 8 px JPEG blocks (82960 / 4 = 20740
// rows stored as 20744): the power-of-two downsample of a padded `img`, else 0.
function paddedDownsample(base: GeoTIFFImage, img: GeoTIFFImage): number {
  const [bw, bh] = [base.getWidth(), base.getHeight()]
  const [w, h] = [img.getWidth(), img.getHeight()]
  const d = 2 ** Math.round(Math.log2(bw / w))
  const padded = w !== Math.ceil(bw / d) || h !== Math.ceil(bh / d)
  return d > 1 &&
    padded &&
    padToTiles(bw, d, 8) === w &&
    padToTiles(bh, d, 8) === h
    ? d
    : 0
}

// Padded images an iScan ImageDescription names a level ("level=2 mag=10
// quality=90"): an unmarked tiled macro can fit the padding too.
const iscanLevels = new WeakSet<GeoTIFFImage>()

// `img` as a level of `base`, or null when it is not one: a tiled image off
// the base aspect ratio (SVS macro between levels) would be stretched over the
// slide. The tolerance is the height error of rounding the width to pixels.
// Philips pads every level to whole tiles (91136x68096 / 128 is stored as
// 1024x1024), so a whole-tile image is a level when some downsample's area,
// padded to tiles, is its size on both axes. Padding hides the downsample
// (91136 / 1024 = 89), so try powers of two from the smallest it allows that
// no earlier (larger) image has taken: a one-tile image fits many.
// Only an image marked reduced-resolution (NewSubfileType bit 0, as Philips
// writes) and not a transparency mask (bit 2) is tried: a tiled macro can
// fit the padding too. A Philips XML states each padded size's downsample
// (any factor); without one, powers of two are tried.
function levelOf(
  base: GeoTIFFImage,
  img: GeoTIFFImage,
  taken: Map<number, TiffLevel>,
  philips?: PhilipsLevel[] | null,
): TiffLevel | null {
  const baseWidth = base.getWidth()
  const baseHeight = base.getHeight()
  const width = img.getWidth()
  const height = img.getHeight()
  const aspect = baseHeight / baseWidth
  const d = iscanLevels.has(img) ? paddedDownsample(base, img) : 0
  if (d)
    return {
      img,
      width: Math.ceil(baseWidth / d),
      height: Math.ceil(baseHeight / d),
      downsample: d,
    }
  if (Math.abs(height - aspect * width) <= 1 + aspect) {
    return { img, width, height, downsample: baseWidth / width }
  }
  const subfileType = Number(img.fileDirectory.getValue('NewSubfileType') ?? 0)
  if ((subfileType & 5) !== 1) return null
  const tileWidth = img.getTileWidth()
  const tileHeight = img.getTileHeight()
  if (width % tileWidth || height % tileHeight) return null
  const stated = philips?.find(
    (l) => l.columns === width && l.rows === height && !taken.has(l.downsample),
  )?.downsample
  if (stated)
    return {
      img,
      width: Math.ceil(baseWidth / stated),
      height: Math.ceil(baseHeight / stated),
      downsample: stated,
    }
  for (
    let d = 2 ** Math.ceil(Math.log2(baseWidth / width));
    padToTiles(baseWidth, d, tileWidth) === width;
    d *= 2
  ) {
    if (!taken.has(d) && padToTiles(baseHeight, d, tileHeight) === height) {
      return {
        img,
        width: Math.ceil(baseWidth / d),
        height: Math.ceil(baseHeight / d),
        downsample: d,
      }
    }
  }
  return null
}

// Tiled images, one per downsample, finest first (NVSlide.selectLevel walks
// levels in order). Philips-2 stores two 512-wide levels (512x1024, 512x512).
function pyramidLevels(
  images: GeoTIFFImage[],
  philips?: PhilipsLevel[] | null,
): TiffLevel[] {
  const tiled = images
    .filter((img) => img.isTiled)
    .sort((a, b) => b.getWidth() - a.getWidth())
  const base = tiled[0]
  if (!base) return []
  const byDownsample = new Map<number, TiffLevel>()
  for (const img of tiled) {
    const level = levelOf(base, img, byDownsample, philips)
    if (level && !byDownsample.has(level.downsample)) {
      byDownsample.set(level.downsample, level)
    }
  }
  return [...byDownsample.values()].sort((a, b) => a.downsample - b.downsample)
}

function buildTiffManifest(
  images: TiffLevel[],
  id: string,
  gray: TiffChannels | null,
  plane?: NVSlidePlaneIndex,
  attribution?: NVSlideAttribution,
): NVSlideManifest {
  const base = images[0]?.img
  if (!base) throw new Error('TIFF has no tiled pyramid levels')
  let totalTiles = 0
  const levels: NVSlideLevelManifest[] = images.map((level, index) => {
    const { img, width, height, ndpi } = level
    const tileWidth = ndpi?.tileWidth ?? img.getTileWidth()
    const tileHeight = ndpi?.tileHeight ?? img.getTileHeight()
    // TIFF 6.0: tile width and length must be multiples of 16. Bioformats
    // writes a one-tile coarsest level at its exact size (e.g. 219x256).
    const tileOk = (n: number, size: number) =>
      Number.isInteger(n) &&
      n <= MAX_TILE_SIZE &&
      ((n >= 16 && n % 16 === 0) || (n >= 1 && n === size))
    if (!tileOk(tileWidth, width) || !tileOk(tileHeight, height)) {
      throw new Error(
        `TIFF level ${index}: tile ${tileWidth}x${tileHeight} is not a multiple of 16 in 16-${MAX_TILE_SIZE}`,
      )
    }
    const columns = Math.ceil(width / tileWidth)
    const rows = Math.ceil(height / tileHeight)
    totalTiles += columns * rows
    if (totalTiles > MAX_TILES) {
      throw new Error(`TIFF has more than ${MAX_TILES} tiles`)
    }
    // Unsigned integers only: geotiff renders float gray black and signed wraps.
    if (!gray && img.getSampleFormat(0) !== 1) {
      throw new Error(
        `TIFF level ${index}: SampleFormat ${img.getSampleFormat(0)} is not supported (unsigned integer only)`,
      )
    }
    // readRGB returns RGB samples unscaled; only 8-bit fits the Uint8 tiles.
    // Gray and palette are scaled to 8-bit by geotiff-rs.
    const photometric = img.fileDirectory.getValue('PhotometricInterpretation')
    if (!gray && photometric === 2 && img.getBitsPerSample(0) !== 8) {
      throw new Error(
        `TIFF level ${index}: ${img.getBitsPerSample(0)}-bit RGB is not supported (8-bit only)`,
      )
    }
    // geotiff-rs decodes 8-bit JPEG only, and no old-style JPEG: reject the
    // level at open rather than fail every tile. 8-bit lossless JPEG still
    // fails per tile, as only the tile stream shows it.
    const compression = img.fileDirectory.getValue('Compression')
    const bits = img.getBitsPerSample(0)
    if (compression === 6 || (compression === 7 && bits !== 8)) {
      const kind = compression === 6 ? 'old-style' : `${bits}-bit`
      throw new Error(
        `TIFF level ${index}: ${kind} JPEG is not supported (8-bit only)`,
      )
    }
    const tiles: (NVSlideTileManifest | null)[] = []
    for (let row = 0; row < rows; row++) {
      for (let col = 0; col < columns; col++) {
        const r = level.regions ? regionTile(level, col, row) : undefined
        tiles.push(
          level.regions && !r
            ? null
            : {
                x: col,
                y: row,
                width: r
                  ? Math.min(tileWidth, r.width - r.x * tileWidth)
                  : Math.min(tileWidth, width - col * tileWidth),
                height: Math.min(
                  tileHeight,
                  (r?.height ?? height) - row * tileHeight,
                ),
              },
        )
      }
    }
    return {
      index,
      width,
      height,
      downsample: level.downsample,
      tileWidth,
      tileHeight,
      columns,
      rows,
      ...(gray
        ? {
            codec: 'raw-gray',
            // WhiteIsZero: NVSlide inverts the windowed level.
            photometric: photometric === 0 ? 'MONOCHROME1' : 'MONOCHROME2',
            bitsStored: gray.kind.bitsStored,
            ...(gray.kind.sampleType
              ? { sampleType: gray.kind.sampleType }
              : {}),
          }
        : { codec: ndpi ? 'image/jpeg' : 'raw-rgba' }),
      ...(plane ? { plane } : {}),
      tiles,
    }
  })
  return {
    id,
    name: `${id} (TIFF)`,
    format: 'tiff',
    width: base.getWidth(),
    height: base.getHeight(),
    tileSize: base.getTileWidth(),
    dtype: !gray
      ? 'uint8'
      : gray.kind.sampleType === 'f32'
        ? 'float32'
        : gray.kind.sampleType === 'i16'
          ? 'int16'
          : `uint${gray.kind.bitsStored}`,
    channels: gray ? 'gray' : 'rgba',
    displayYAxis: 'down',
    levels,
    ...(gray ? { channelInfo: gray.info } : {}),
    ...(attribution ? { attribution } : {}),
  }
}

// readRGB with enableAlpha yields 3 samples per pixel, or every sample of an
// RGB image with ExtraSamples: the first extra is alpha, further ones are
// skipped. The case is chosen once per tile so each pixel loop stays branch-free.
function toRgba(
  rgb: ArrayLike<number>,
  pixels: number,
  associatedAlpha: boolean,
): Uint8Array {
  const stride = rgb.length / pixels
  if (stride === 4 && !associatedAlpha && rgb instanceof Uint8Array) return rgb
  const rgba = new Uint8Array(pixels * 4)
  const n = pixels * 4
  if (stride === 3) {
    for (let i = 0, j = 0; i < n; i += 4, j += 3) {
      rgba[i] = rgb[j]
      rgba[i + 1] = rgb[j + 1]
      rgba[i + 2] = rgb[j + 2]
      rgba[i + 3] = 255
    }
  } else if (!associatedAlpha) {
    for (let i = 0, j = 0; i < n; i += 4, j += stride) {
      rgba[i] = rgb[j]
      rgba[i + 1] = rgb[j + 1]
      rgba[i + 2] = rgb[j + 2]
      rgba[i + 3] = rgb[j + 3]
    }
  } else {
    // Associated alpha is premultiplied; NVSlide takes straight alpha. The
    // clamped view rounds and caps colour > alpha in malformed files.
    const out = new Uint8ClampedArray(rgba.buffer)
    for (let i = 0, j = 0; i < n; i += 4, j += stride) {
      const a = rgb[j + 3]
      const k = a ? 255 / a : 0
      out[i] = rgb[j] * k
      out[i + 1] = rgb[j + 1] * k
      out[i + 2] = rgb[j + 2] * k
      out[i + 3] = a
    }
  }
  return rgba
}

// geotiff-rs ships no JPEG 2000 codec. dcm2niix's OpenJPEG returns the whole
// tile as final 8-bit RGB (or gray): it upsamples 33003's half-width chroma
// and converts YCbCr itself, and geotiff-rs converts nothing after it.
// ponytail: dcm2niix refuses tiles over 2048 px ('too-large'); MAX_TILE_SIZE allows 4096.
class Dcm2niixJpeg2000Decoder extends BaseDecoder {
  async decodeBlock(buffer: ArrayBufferLike): Promise<ArrayBufferLike> {
    const { tileWidth, tileHeight, bitsPerSample, planarConfiguration } =
      this.parameters
    const frame = await sharedDcm2niixDecoders().decodeSamples(
      new Uint8Array(buffer),
    )
    // geotiff-rs places 8-bit samples by the TIFF's tile size and sample count;
    // a grey codestream in an RGB TIFF would leave it a short buffer.
    const perPixel =
      planarConfiguration === 2 || typeof bitsPerSample === 'number'
        ? 1
        : (bitsPerSample?.length ?? 1)
    if (
      frame.width !== tileWidth ||
      frame.height !== tileHeight ||
      frame.samples.byteLength !== tileWidth * tileHeight * perPixel
    ) {
      throw new Error(
        `JPEG 2000 tile is ${frame.width}x${frame.height} (${frame.samples.byteLength} bytes), TIFF declares ${tileWidth}x${tileHeight} x ${perPixel} samples`,
      )
    }
    return frame.samples.buffer // transferred from the worker, exactly the samples
  }
}

/**
 * Decode JPEG 2000 TIFF tiles (Aperio SVS 33003 and 33005, TIFF 34712) with
 * dcm2niix's WASM worker pool, loaded on the first such tile and shared with
 * `registerDcm2niixDecoders` from `/dicom`. Without it, such tiles fail with
 * geotiff-rs's "no built-in decoder" error. Call it before reading tiles; it
 * replaces any decoder registered for those compressions.
 * Needs the optional peer dependency `@niivue/dcm2niix`.
 */
export function registerDcm2niixTiffDecoders(): void {
  // preferWorker false: registrations do not reach geotiff Pool workers; the
  // decode runs in dcm2niix's own workers.
  addDecoder(
    [33003, 33005, 34712],
    async () => Dcm2niixJpeg2000Decoder,
    undefined,
    false,
  )
}

// NDPI levels: the main chain's JPEG strips with a magnification (not the
// macro or map), finest first. A strip without restart intervals is one tile
// if it fits one; otherwise it is not a level.
async function ndpiLevels(
  tiff: GeoTIFF,
  first: GeoTIFFImage,
): Promise<TiffLevel[]> {
  const images: GeoTIFFImage[] = []
  for (const img of await chainImages(tiff, first))
    if (
      img.fileDirectory.getValue('Compression') === 7 &&
      Number(await img.fileDirectory.loadValue(NDPI_SOURCELENS)) > 0
    )
      images.push(img)
  images.sort((a, b) => b.getWidth() - a.getWidth())
  const baseWidth = images[0]?.getWidth() ?? 0
  const levels: TiffLevel[] = []
  for (const img of images) {
    const dir = img.fileDirectory
    const offsets = await dir.loadValue('StripOffsets')
    const counts = await dir.loadValue('StripByteCounts')
    if (offsets?.length !== 1) continue
    const strip = Number(offsets[0])
    const count = Number(counts?.[0])
    const [head] = await tiff.source.fetch([
      { offset: strip, length: Math.min(count, 65536) },
    ])
    const width = img.getWidth()
    const height = img.getHeight()
    let jpeg: NdpiJpeg | null = null
    try {
      // Its size from the TIFF: the SOF's 16-bit fields wrap past 65535 px.
      jpeg = ndpiJpeg(new Uint8Array(head as ArrayBuffer), width, height)
    } catch {
      if (width > MAX_TILE_SIZE || height > MAX_TILE_SIZE) continue
    }
    const grid = jpeg
      ? ndpiGrid(jpeg)
      : {
          across: 1,
          down: 1,
          tileWidth: width,
          tileHeight: height,
          columns: 1,
          rows: 1,
        }
    levels.push({
      img,
      width,
      height,
      downsample: baseWidth / width,
      ndpi: { ...grid, strip, count, jpeg },
    })
  }
  return levels
}

// An ASCII or byte tag's text.
const tagText = (v: unknown): string =>
  typeof v === 'string'
    ? v
    : new TextDecoder().decode(Uint8Array.from((v ?? []) as ArrayLike<number>))

// Argos z-stack: one pyramid per focal plane in the main chain, the middle
// plane by default. Null when the file is not a stack.
async function argosOpened(
  tiff: GeoTIFF,
  first: GeoTIFFImage,
  z?: number,
): Promise<TiffOpened | null> {
  const images = await chainImages(tiff, first)
  const stack = argosStack(
    tagText(await first.fileDirectory.loadValue(ARGOS_TAG)),
    images.map((img) => ({
      width: img.getWidth(),
      height: img.getHeight(),
      tiled: img.isTiled,
    })),
  )
  if (!stack) return null
  const plane = { z: z ?? stack.middle, t: 0 }
  checkIndex('z', plane.z, stack.planes.length)
  const openPlane = async (p: NVSlidePlaneIndex) => [
    pyramidLevels(
      (stack.planes[p.z] ?? []).map((i) => images[i] as GeoTIFFImage),
    ),
  ]
  return {
    pyramids: await openPlane(plane),
    channels: null,
    plane,
    axes: { z: stack.planes.length, t: 1 },
    openPlane,
  }
}

const storageOf = (l: TiffLevel) => {
  const tileWidth = l.img.getTileWidth()
  const tileHeight = l.img.getTileHeight()
  return {
    width: l.width,
    height: l.height,
    tileWidth,
    tileHeight,
    columns: Math.ceil(l.width / tileWidth),
    rows: Math.ceil(l.height / tileHeight),
    downsample: l.downsample,
  }
}

// TiffSlideOptions.placement: a vendor layout's levels and placement (Trestle
// overlaps, Leica regions, Ventana joints); null for other files. A layout
// that does not resolve warns and keeps the grid.
// Ventana-1's XMP is 0.4 MB and an iScan Coreo one a few MB.
const MAX_XMP = 16 << 20

// A tag's value, refused past `max` bytes before any of it is read: geotiff-rs
// keeps no element count for a deferred tag, so the read is bounded at the source.
async function loadCapped(
  tiff: GeoTIFF,
  dir: GeoTIFFImage['fileDirectory'],
  tag: number,
  max: number,
): Promise<unknown> {
  const source = tiff.source
  const fetch = source.fetch
  source.fetch = (slices, signal) =>
    slices.some((sl) => sl.length > max)
      ? Promise.reject(new Error(`tag ${tag} over ${max} bytes`))
      : fetch.call(source, slices, signal)
  try {
    return await dir.loadValue(tag)
  } finally {
    source.fetch = fetch
  }
}

async function placedPyramid(
  tiff: GeoTIFF,
  first: GeoTIFFImage,
  description: string,
): Promise<{
  levels: TiffLevel[]
  placement?: VendorPlacement
  report?: TiffPlacementReport
} | null> {
  const images = await chainImages(tiff, first)
  const warn = (what: string, err: unknown) => {
    console.warn(`${what}: ${err instanceof Error ? err.message : err}`)
    return null
  }
  const overlaps = trestleOverlaps(description)
  if (overlaps) {
    // Each level is its own overlapping mosaic, so sizes do not keep the aspect.
    const tiled = images
      .filter((img) => img.isTiled)
      .sort((a, b) => b.getWidth() - a.getWidth())
    const storage = tiled.map((img) =>
      storageOf({
        img,
        width: img.getWidth(),
        height: img.getHeight(),
        downsample: 1,
      }),
    )
    try {
      const placement = trestlePlacement(overlaps, storage)
      const levels = tiled.map((img, k) => ({
        img,
        width: img.getWidth(),
        height: img.getHeight(),
        downsample: placement.width / (placement.levels[k]?.width ?? 1),
      }))
      return { levels, placement }
    } catch (err) {
      return warn('Trestle overlaps not applied', err)
    }
  }
  const leica = leicaRegions(description)?.filter((r) => r.brightfield)
  if (leica?.length) {
    const pyramids = leica.map((r) =>
      pyramidLevels(r.ifds.flatMap((i) => images[i] ?? [])),
    )
    if (pyramids.some((p) => !p.length)) return null
    if (pyramids.length === 1) return { levels: pyramids[0] as TiffLevel[] }
    try {
      const { grids, placement } = leicaComposition(
        leica,
        pyramids.map((p) => p.map(storageOf)),
      )
      const levels = grids.map((g, k): TiffLevel => {
        const at = pyramids.map((p) => p[k] as TiffLevel)
        const l0 = at[0] as TiffLevel
        return {
          img: l0.img,
          width: g.columns * g.tileWidth,
          height: g.rows * g.tileHeight,
          downsample: l0.downsample,
          regions: at.map((l, i) => ({
            ...storageOf(l),
            img: l.img,
            colStart: g.colStart[i] as number,
          })),
        }
      })
      return { levels, placement }
    } catch (err) {
      return warn('Leica regions not composed', err)
    }
  }
  const levels = pyramidLevels(images)
  const dir = levels[0]?.img.fileDirectory
  if (!dir?.hasTag(700)) return null
  let xmp: string
  try {
    xmp = tagText(await loadCapped(tiff, dir, 700, MAX_XMP))
  } catch (err) {
    const warning = `XMP not read: ${err instanceof Error ? err.message : err}`
    console.warn(warning)
    return { levels, report: { warning } }
  }
  if (!isVentanaXmp(xmp)) return null
  const placed = ventanaPlacement(xmp, levels.map(storageOf))
  if ('warning' in placed) {
    console.warn(placed.warning)
    return { levels, report: { warning: placed.warning } }
  }
  return {
    levels,
    placement: placed.placement,
    report: {
      seams: placed.seams,
      ...(placed.notice && { notice: placed.notice }),
    },
  }
}

function fileName(url: string): string {
  const last = url.replace(/[?#].*$/, '').replace(/^.*\//, '')
  try {
    return decodeURIComponent(last) || url
  } catch {
    return last || url
  }
}

/**
 * NVSlide tile source for tiled/pyramidal TIFF, BigTIFF, OME-TIFF and Aperio
 * SVS. geotiff-rs parses IFDs lazily and reads one tile's bytes per request, then
 * decodes it (JPEG incl. JPEGTables, LZW, Deflate, PackBits, ZSTD, WebP, LERC;
 * JPEG 2000 after {@link registerDcm2niixTiffDecoders}).
 * - RGB, palette, YCbCr and CMYK reach NVSlide as raw RGBA, cropped at the
 *   right/bottom edge.
 * - A one-sample grey image (BlackIsZero/WhiteIsZero) is raw-gray samples with
 *   one `manifest.channelInfo` entry: u8/u16/i16/f32 native, wider types
 *   quantized to uint16 (`storedToValue`).
 * - A multi-channel OME-TIFF states one entry per channel and serves the visible
 *   ones through `fetchTileSamples`, as ZarrSlideSource; a hidden channel's
 *   window is read when it is first shown.
 * - An OME-TIFF with several z or t planes is `SlidePlaneCapable`.
 *
 * NVSlide.dispose() disposes a source it owns (the default); a slide made with
 * `{ ownsSource: false }` leaves {@link dispose} to the caller.
 */
export class TiffSlideSource implements SlideTileSource {
  readonly manifest: NVSlideManifest
  /** Set only for a multi-channel OME-TIFF: NVSlide composites its channels. */
  readonly fetchTileSamples?: SlideTileSource['fetchTileSamples']
  /** An OME-TIFF z/t stack's planes (`SlidePlaneCapable`); unset otherwise. */
  readonly planes?: NVSlidePlaneAxes
  readonly preparePlane?: SlidePlaneCapable['preparePlane']
  /** A vendor layout's grid fallback warning, or the per-seam residuals. */
  readonly placementReport?: TiffPlacementReport
  private host: SlideSourceHost | null = null
  private readonly closed = new AbortController()
  /** Each opened plane's channel pyramids, by planeKey. */
  private readonly pyramids = new Map<string, TiffLevel[][]>()
  private readonly channels: TiffChannels | null
  private warnedRegion = false
  /** A hidden channel's range read, shared by every tile that waits for it. */
  private readonly ready: (Promise<void> | undefined)[] = []

  private constructor(
    private readonly tiff: GeoTIFF,
    private readonly opened: TiffOpened,
    private readonly id: string,
    private readonly pool: Pool | undefined,
    private readonly client: RangeClient | null,
    // Not `attribution`: a public field of that name is the host's to add.
    private readonly credit: NVSlideAttribution | undefined,
  ) {
    this.channels = opened.channels
    this.placementReport = opened.placementReport
    this.pyramids.set(planeKey(opened.plane), opened.pyramids)
    this.manifest = this.build(
      opened.pyramids,
      opened.axes ? opened.plane : undefined,
    )
    if ((this.channels?.info.length ?? 0) > 1)
      this.fetchTileSamples = this.tileSamples.bind(this)
    if (opened.axes) {
      this.planes = opened.axes
      this.preparePlane = this.openPlane.bind(this)
    }
  }

  private build(
    pyramids: TiffLevel[][],
    plane?: NVSlidePlaneIndex,
  ): NVSlideManifest {
    const manifest = buildTiffManifest(
      pyramids[0] ?? [],
      this.id,
      this.channels,
      plane,
      this.credit,
    )
    const placed = this.opened.placement
    if (!placed) return manifest
    // F7: levels keep their storage grid; the manifest takes the placed extent.
    manifest.width = placed.width
    manifest.height = placed.height
    for (const [i, level] of manifest.levels.entries()) {
      const placement = placed.levels[i]
      if (placement) level.placement = placement
    }
    return manifest
  }

  /** Stream a remote TIFF by HTTP Range. Rejects if the server ignores Range. */
  static async fromUrl(
    url: string,
    options: TiffSlideUrlOptions = {},
  ): Promise<TiffSlideSource> {
    const client = new RangeClient(
      url,
      slideFetch(options.fetch),
      !!options.fetch,
    )
    const fail = (error: unknown): never => {
      options.signal?.throwIfAborted()
      throw client.lastError ?? error
    }
    client.openSignal = options.signal ?? null
    let tiff: GeoTIFF
    let opened: TiffOpened
    try {
      tiff = await fromCustomClient(
        client,
        SOURCE_OPTIONS,
        options.signal,
      ).catch(fail)
      opened = await openTiff(tiff, options, options.signal).catch(fail)
    } finally {
      // Until the source exists; then its lifetime (below).
      client.openSignal = null
    }
    options.signal?.throwIfAborted()
    const source = new TiffSlideSource(
      tiff,
      opened,
      options.id ?? fileName(url),
      options.pool,
      client,
      cleanAttribution(options.attribution),
    )
    client.openSignal = source.closed.signal
    return source
  }

  /** Wrap an already-open GeoTIFF, e.g. `fromBlob(file)` for a local file. */
  static async fromGeoTIFF(
    tiff: GeoTIFF,
    options: TiffSlideOptions & { signal?: AbortSignal } = {},
  ): Promise<TiffSlideSource> {
    const opened = await openTiff(tiff, options, options.signal)
    options.signal?.throwIfAborted()
    return new TiffSlideSource(
      tiff,
      opened,
      options.id ?? 'tiff',
      options.pool,
      null,
      cleanAttribution(options.attribution),
    )
  }

  bind(host: SlideSourceHost): void {
    this.host = host
    this.client?.bind(host)
  }

  /** The channel pyramids of the plane a level reads. */
  private pyramidsOf(level: NVSlideLevelManifest): TiffLevel[][] {
    const p = level.plane ?? this.opened.plane
    const pyramids = this.pyramids.get(planeKey(p))
    if (!pyramids)
      throw new Error(`TIFF plane {z: ${p.z}, t: ${p.t}} was not prepared`)
    return pyramids
  }

  /** SlidePlaneCapable.preparePlane: reads the plane's IFDs, no pixels. */
  private async openPlane(
    p: NVSlidePlaneIndex,
    signal?: AbortSignal,
  ): Promise<NVSlideManifest> {
    const { axes, openPlane } = this.opened
    const within = (v: number, n = 0) => Number.isInteger(v) && v >= 0 && v < n
    if (!axes || !openPlane || !within(p.z, axes.z) || !within(p.t, axes.t))
      throw new RangeError(
        `TIFF plane {z: ${p.z}, t: ${p.t}} is not in {z: 0-${(axes?.z ?? 1) - 1}, t: 0-${(axes?.t ?? 1) - 1}}`,
      )
    signal?.throwIfAborted()
    const key = planeKey(p)
    let pyramids = this.pyramids.get(key)
    if (!pyramids) {
      pyramids = await settleBy(
        anySignal(signal, this.closed.signal),
        openPlane(p),
      )
      // F14: every plane serves the open plane's channels and quantization.
      if (
        planeShape(pyramids).join('|') !==
        planeShape(this.opened.pyramids).join('|')
      )
        throw new RangeError(
          `TIFF plane {z: ${p.z}, t: ${p.t}}: its pyramid differs from the open plane's`,
        )
      this.pyramids.set(key, pyramids)
    }
    return this.build(pyramids, p)
  }

  /**
   * A hidden channel's window and quantization, read once on first need and
   * stated through SlideSourceHost.channelInfoChanged before its first tile.
   * Tied to the source's lifetime, not to one tile's request.
   */
  private channelReady(
    c: number,
    levels: TiffLevel[] | undefined,
  ): Promise<void> | undefined {
    const channels = this.channels
    if (!channels || channels.quantize[c] !== undefined) return undefined
    if (!levels) return Promise.reject(new Error(`No TIFF channel ${c}`))
    this.ready[c] ??= channelDisplay(
      levels,
      channels.kind,
      this.pool,
      this.closed.signal,
    ).then(
      (display) => {
        const patch = displayPatch(display)
        Object.assign(channels.info[c] as NVSlideChannelInfo, patch)
        channels.quantize[c] = display.q
        this.ready[c] = undefined
        this.host?.channelInfoChanged(c, patch)
      },
      (error) => {
        this.ready[c] = undefined // a later tile reads it again
        throw error
      },
    )
    return this.ready[c]
  }

  /** The base image's ICC profile (tag 34675, e.g. Aperio SVS); null without one. */
  async fetchIccProfile(signal?: AbortSignal): Promise<Uint8Array | null> {
    const dir = this.opened.pyramids[0]?.[0]?.img.fileDirectory
    // By number: geotiff 3's name lookup does not resolve 'ICCProfile'.
    if (!dir?.hasTag(34675)) return null
    // geotiff caches the value: a disposed source must not serve it.
    this.closed.signal.throwIfAborted()
    signal?.throwIfAborted()
    // geotiff's loadValue takes no signal: an abort stops the wait here, and
    // dispose() cancels the read itself (RangeClient.openSignal).
    const value: ArrayLike<number> | undefined = await settleBy(
      signal,
      dir.loadValue(34675),
    )
    if (!value) return null
    return value instanceof Uint8Array ? value : Uint8Array.from(value)
  }

  async fetchTileBytes(
    level: NVSlideLevelManifest,
    tile: NVSlideTileManifest,
    label: string,
    signal?: AbortSignal,
  ): Promise<Uint8Array> {
    // NVSlide calls fetchTileSamples instead when the source has it.
    if (this.fetchTileSamples)
      throw new Error(
        'Multi-channel OME-TIFF: read tiles with fetchTileSamples',
      )
    const abort = anySignal(signal, this.closed.signal)
    this.host?.pushRangeEvent({ label, status: 'pending' })
    try {
      abort.throwIfAborted()
      const lvl = this.pyramidsOf(level)[0]?.[level.index]
      if (lvl?.ndpi) {
        const bytes = await this.ndpiTile(lvl, tile, abort)
        this.host?.updateRangeEvent(label, 'hit')
        return bytes
      }
      // A Leica region's own tile grid, when regions share the level's.
      const at = lvl?.regions
        ? regionTile(lvl, tile.x, tile.y)
        : lvl && {
            img: lvl.img,
            x: tile.x,
            y: tile.y,
            columns: level.columns,
            rows: level.rows,
          }
      if (!at && lvl?.regions) {
        // Between Leica regions: no image holds it, so it is absent, not an error.
        if (!this.warnedRegion) {
          this.warnedRegion = true
          console.warn(
            `TIFF level ${level.index} tile ${tile.x},${tile.y} is in no Leica region; shown absent`,
          )
        }
        this.host?.updateRangeEvent(label, 'hit')
        const bytes = this.channels
          ? planeArray(this.channels.kind).BYTES_PER_ELEMENT
          : 4
        return new Uint8Array(tile.width * tile.height * bytes)
      }
      if (!at)
        throw new Error(`No TIFF level ${level.index} tile ${tile.x},${tile.y}`)
      const { img } = at
      const gray = this.channels
      const pixels = tile.width * tile.height
      // TileByteCounts 0 marks a tile absent (Philips sparse ROIs, Aperio);
      // like OpenSlide, show RGB transparent rather than decode zeros (green
      // through YCbCr). Planar configuration 2 stores one tile per sample, so
      // the tile is absent only when every sample's is; geotiff fills a lone
      // absent sample with zeros. Grey has no alpha: absent is zeros, as a
      // multi-channel plane or a Zarr fill value.
      const index = at.y * at.columns + at.x
      const planes =
        img.fileDirectory.getValue('PlanarConfiguration') === 2
          ? img.getSamplesPerPixel()
          : 1
      // Indexed reads, one block each, not the whole table: concurrent reads
      // of one image's counts are safe (tested), unlike NDPI's tag 65426.
      let absent = true
      for (let s = 0; s < planes && absent; s++) {
        const byteCount = await img.fileDirectory.loadValueIndexed(
          'TileByteCounts',
          index + s * at.columns * at.rows,
        )
        absent = Number(byteCount) === 0
      }
      abort.throwIfAborted()
      const x0 = at.x * img.getTileWidth()
      const y0 = at.y * img.getTileHeight()
      const window = [x0, y0, x0 + tile.width, y0 + tile.height]
      let bytes: Uint8Array
      if (gray) {
        const Samples = planeArray(gray.kind)
        if (absent) bytes = new Uint8Array(pixels * Samples.BYTES_PER_ELEMENT)
        else {
          const [data] = await img.readRasters({
            window,
            samples: [0],
            pool: this.pool,
            signal: abort,
          })
          bytes = grayBytes(
            data as ArrayLike<number>,
            Samples,
            gray.quantize[0] ?? null,
            tile.width,
            tile.height,
          )
        }
      } else if (absent) bytes = new Uint8Array(pixels * 4)
      else {
        const rgb = await img.readRGB({
          window,
          interleave: true,
          pool: this.pool,
          signal: abort,
          enableAlpha: true,
        })
        bytes = toRgba(
          rgb,
          pixels,
          img.fileDirectory.getValue('ExtraSamples')?.[0] === 1,
        )
      }
      abort.throwIfAborted()
      this.host?.updateRangeEvent(label, 'hit')
      return bytes
    } catch (error) {
      this.host?.updateRangeEvent(label, abort.aborted ? 'aborted' : 'failed')
      throw error
    }
  }

  /** An NDPI virtual tile: its restart intervals wrapped as one JPEG. */
  private async ndpiTile(
    { img, ndpi }: TiffLevel,
    tile: NVSlideTileManifest,
    signal: AbortSignal,
  ): Promise<Uint8Array> {
    const n = ndpi as NdpiLevel
    const source = this.tiff.source
    const j = n.jpeg
    if (!j) {
      if (!(n.count <= MAX_NDPI_READ))
        throw new Error(
          `NDPI strip of ${n.count} bytes without restart markers, over ${MAX_NDPI_READ}`,
        )
      const [all] = await source.fetch(
        [{ offset: n.strip, length: n.count }],
        signal,
      )
      return new Uint8Array(all as ArrayBuffer)
    }
    // The whole offset list, once per level: geotiff-rs drops concurrent
    // indexed reads of one deferred array.
    if (!n.starts) {
      const load: Promise<ArrayLike<number>> =
        img.fileDirectory.loadValue(NDPI_MCU_STARTS)
      n.starts = load
      // A failed read is retried by the next tile, not cached.
      load.catch(() => {
        if (n.starts === load) n.starts = undefined
      })
    }
    const starts = await settleBy(signal, n.starts)
    const last = j.perRow * j.mcuRows
    if (!(starts.length >= last))
      throw new Error(
        `NDPI: ${starts.length} restart offsets for ${last} intervals`,
      )
    // Offsets are untrusted: each stays in [lo, strip end], so a span never
    // runs past the strip (or goes negative) whatever the table says.
    const at = (i: number, lo: number) => {
      const v = i < last ? Number(starts[i]) : n.count
      return v >= lo ? Math.min(v, n.count) : lo
    }
    const c0 = tile.x * n.across
    const c1 = Math.min(j.perRow, c0 + n.across)
    const spans: { offset: number; length: number; ends: number[] }[] = []
    let bytes = 0
    for (
      let r = tile.y * n.down;
      r < Math.min(j.mcuRows, (tile.y + 1) * n.down);
      r++
    ) {
      const a = at(r * j.perRow + c0, 0)
      const ends: number[] = []
      let e = a
      for (let i = c0 + 1; i <= c1; i++) {
        e = at(r * j.perRow + i, e)
        ends.push(e - a - 2)
      }
      spans.push({ offset: n.strip + a, length: e - a, ends })
      bytes += e - a
    }
    if (bytes > MAX_NDPI_READ)
      throw new Error(`NDPI tile of ${bytes} bytes, over ${MAX_NDPI_READ}`)
    const data = await source.fetch(spans, signal)
    return ndpiTileJpeg(
      j,
      tile.width,
      tile.height,
      spans.map((s, k) => ({
        bytes: new Uint8Array(data[k] as ArrayBuffer),
        ends: s.ends,
      })),
    )
  }

  /** Planar samples of `channels`, one plane read each. */
  private async tileSamples(
    level: NVSlideLevelManifest,
    tile: NVSlideTileManifest,
    channels: readonly number[],
    signal?: AbortSignal,
  ): Promise<NVSlideTileSamples> {
    const { width: w, height: h } = tile
    const gray = this.channels as TiffChannels
    const out = new (planeArray(gray.kind))(w * h * channels.length)
    const abort = anySignal(signal, this.closed.signal)
    const pyramids = this.pyramidsOf(level)
    // Hidden channels shown for the first time: their windows first.
    await settleBy(
      abort,
      Promise.all(channels.map((c) => this.channelReady(c, pyramids[c]))),
    )
    const x0 = tile.x * (level.tileWidth ?? 0)
    const y0 = tile.y * (level.tileHeight ?? 0)
    await Promise.all(
      channels.map(async (c, plane) => {
        const label = `${level.index}/${tile.x}/${tile.y} c${c}`
        this.host?.pushRangeEvent({ label, status: 'pending' })
        try {
          const img = pyramids[c]?.[level.index]?.img
          if (!img) throw new Error(`No TIFF channel ${c} level ${level.index}`)
          abort.throwIfAborted()
          // A zero-byte (absent) tile reads as zeros: black in a channel.
          const [data] = await img.readRasters({
            window: [x0, y0, x0 + w, y0 + h],
            samples: [0],
            pool: this.pool,
            signal: abort,
          })
          abort.throwIfAborted()
          grayInto(
            out,
            plane * w * h,
            data as ArrayLike<number>,
            w,
            1,
            w,
            h,
            gray.quantize[c] ?? null,
          )
          this.host?.updateRangeEvent(label, 'hit')
        } catch (error) {
          this.host?.updateRangeEvent(
            label,
            abort.aborted ? 'aborted' : 'failed',
          )
          throw error
        }
      }),
    )
    return {
      samples: out,
      width: w,
      height: h,
      bitsStored: gray.kind.bitsStored,
      planes: channels.length,
    }
  }

  /** Abort in-flight reads and close the file. The caller's pool is left alone. */
  dispose(): void {
    if (this.closed.signal.aborted) return
    this.closed.abort()
    // Closing a file source twice (or a closed fd) rejects with EBADF.
    Promise.resolve(this.tiff.close()).catch(() => {})
  }
}

// One grey tile as raw-gray bytes: native samples as read (no copy), others
// widened or quantized into the level's sample type.
function grayBytes(
  data: ArrayLike<number>,
  Samples: ReturnType<typeof planeArray>,
  q: Quantize | null,
  w: number,
  h: number,
): Uint8Array {
  if (!q && data instanceof Samples)
    return new Uint8Array(data.buffer, data.byteOffset, data.byteLength)
  const out = new Samples(w * h)
  grayInto(out, 0, data, w, 1, w, h, q)
  return new Uint8Array(out.buffer)
}
