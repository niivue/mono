import type {
  NVSlideLevelManifest,
  NVSlideManifest,
  NVSlideTileManifest,
  SlideSourceHost,
  SlideTileSource,
} from '@niivue/niivue'
import { tileMap } from './dicomIndex'
import type { DicomJsonSlide } from './dicomJson'
import { manifestOf } from './dicomWsiSource'
import { parseMultipartRelated } from './multipart'

// 64 MB: far beyond a tile or scanner ICC profile (Leica's is 13 MB); matches
// ManifestRangeSource's profile cap and the dcm2niix decoder's input cap.
const MAX_BODY = 64 * 1024 * 1024
const ANY_SYNTAX =
  'multipart/related; type="application/octet-stream"; transfer-syntax=*'

export interface DicomWebWsiOptions {
  /** The series' WADO-RS URL: `{wadoRoot}/studies/{study}/series/{series}`. */
  seriesUrl: string
  /** Headers for each request to the seriesUrl origin, read per request so refreshed auth is used. */
  headers?: () => Record<string, string>
  /**
   * Fetches ICC bulk data by its resolved URL (e.g. OHIF's
   * dataSource.retrieve.bulkDataURI); without it, fetch with `headers`.
   */
  retrieveBulkData?: (
    url: string,
    signal?: AbortSignal,
  ) => Promise<ArrayBuffer | Uint8Array>
}

/** SOI then the first frame marker: 0xf7 (SOF55) is JPEG-LS, 0xc0-0xcf JPEG; undefined otherwise. */
function sofMarker(b: Uint8Array): number | undefined {
  if (b[0] !== 0xff || b[1] !== 0xd8) return undefined
  for (let i = 2; i + 3 < b.length; ) {
    if (b[i] !== 0xff) return undefined
    const m = b[i + 1] as number
    if (m === 0xff) {
      i++ // fill byte
      continue
    }
    // DHT, JPG, DAC and SOS share the 0xc0-0xcf / scan range but are not frames.
    if (
      m === 0xf7 ||
      (m >= 0xc0 && m <= 0xcf && m !== 0xc4 && m !== 0xc8 && m !== 0xcc)
    )
      return m
    if (m === 0xda) return undefined
    i += 2 + (((b[i + 2] as number) << 8) | (b[i + 3] as number))
  }
  return undefined
}

/** A J2K codestream (start-of-codestream + image-size markers) or a JP2 file (signature box). */
function isJpeg2000(b: Uint8Array): boolean {
  if (b[0] === 0xff && b[1] === 0x4f && b[2] === 0xff && b[3] === 0x51)
    return true
  return (
    b[3] === 0x0c &&
    b[4] === 0x6a &&
    b[5] === 0x50 &&
    b[6] === 0x20 &&
    b[7] === 0x20
  )
}

/** The transfer syntax a frame's bytes are in, for a server whose metadata does not say. */
function sniffSyntax(frame: Uint8Array): string {
  if (isJpeg2000(frame)) return '1.2.840.10008.1.2.4.90'
  const sof = sofMarker(frame)
  if (sof === 0xf7) return '1.2.840.10008.1.2.4.80'
  if (sof !== undefined) return '1.2.840.10008.1.2.4.50'
  throw new Error('WSI frame is not JPEG, JPEG 2000 or JPEG-LS')
}

/** A response body, refused past MAX_BODY whether or not Content-Length says so. */
async function readCapped(
  response: Response,
  what: string,
): Promise<Uint8Array> {
  const refused = !response.ok
    ? `${what} HTTP ${response.status}`
    : Number(response.headers.get('content-length')) > MAX_BODY
      ? `${what} body too large`
      : undefined
  if (refused) {
    // An unread body keeps its connection downloading.
    await response.body?.cancel()
    throw new Error(refused)
  }
  const reader = response.body?.getReader()
  if (!reader) return new Uint8Array(0)
  const chunks: Uint8Array[] = []
  let n = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    n += value.length
    if (n > MAX_BODY) {
      await reader.cancel()
      throw new Error(`${what} body too large`)
    }
    chunks.push(value)
  }
  if (chunks.length === 1) return chunks[0] as Uint8Array
  const out = new Uint8Array(n)
  let o = 0
  for (const c of chunks) {
    out.set(c, o)
    o += c.length
  }
  return out
}

/** The first part of a (multipart/related) response. */
async function firstPart(
  response: Response,
  what: string,
): Promise<Uint8Array> {
  const body = await readCapped(response, what)
  const part = parseMultipartRelated(
    body,
    response.headers.get('content-type') ?? '',
  )[0]
  if (!part?.length) throw new Error(`empty ${what} body`)
  return part
}

/**
 * A SlideTileSource for one slide of {@link indexDicomWsiMetadata}, fetching
 * each tile from a DICOMweb server by WADO-RS `/frames/{n}`. Open with
 * {@link DicomWebWsiSource.open}.
 */
export class DicomWebWsiSource implements SlideTileSource {
  readonly manifest: NVSlideManifest
  private readonly maps: Int32Array[]
  /** seriesUrl, resolved against the page when relative. */
  private readonly series: URL
  private host: SlideSourceHost | null = null

  private constructor(
    readonly slide: DicomJsonSlide,
    private readonly options: DicomWebWsiOptions,
  ) {
    this.maps = slide.levels.map(tileMap)
    this.series = seriesOf(options.seriesUrl)
    const icc = slide.iccProfile
    this.manifest = manifestOf(
      { ...slide, iccProfile: icc && { colorSpace: icc.colorSpace } },
      this.maps,
      {
        format: 'dicom-wsi-web',
        // NVSlide reads only the profile's colorSpace; fetchIccProfile fetches it.
        fileUrl: () =>
          icc?.bulkDataURI ? this.bulkUrl(icc.bulkDataURI) : this.series.href,
      },
    )
  }

  /**
   * The source for `slide`. A level whose metadata states no transfer syntax
   * costs one frame request here, to read it from the bytes.
   */
  static async open(
    slide: DicomJsonSlide,
    options: DicomWebWsiOptions,
    signal?: AbortSignal,
  ): Promise<DicomWebWsiSource> {
    const instances = slide.instances.map((i) => ({ ...i }))
    const series = seriesOf(options.seriesUrl)
    for (const level of slide.levels) {
      const i = level.frames.instance[0]
      const frame = level.frames.frame[0]
      const inst = instances[i as number]
      if (!inst || inst.transferSyntax || frame === undefined) continue
      const response = await fetch(frameUrl(series, inst.id, frame), {
        headers: { ...options.headers?.(), Accept: ANY_SYNTAX },
        signal,
      })
      let ts: string
      if (response.status === 406) {
        // No stored bytes on offer: tiles then ask for image/jpeg, the old default.
        await response.body?.cancel()
        ts = '1.2.840.10008.1.2.4.50'
      } else ts = sniffSyntax(await firstPart(response, 'WSI frame'))
      for (const k of level.instances)
        (instances[k] as typeof inst).transferSyntax = ts
    }
    return new DicomWebWsiSource({ ...slide, instances }, options)
  }

  bind(host: SlideSourceHost): void {
    this.host = host
  }

  private bulkUrl(uri: string): string {
    const { origin, pathname, search } = this.series
    // Relative to the series resource, as its /metadata states them.
    const url = new URL(uri, `${origin}${pathname}/`)
    // A token in the series query is needed by its server's bulk data too.
    if (url.origin === origin && !url.search) url.search = search
    return url.href
  }

  async fetchTileBytes(
    level: NVSlideLevelManifest,
    tile: NVSlideTileManifest,
    _label: string,
    signal?: AbortSignal,
  ): Promise<Uint8Array> {
    const { frames } = this.slide.levels[
      level.index
    ] as DicomJsonSlide['levels'][number]
    const map = this.maps[level.index] as Int32Array
    const slot = map[tile.y * level.columns + tile.x] as number
    if (!(slot >= 0)) throw new Error(`no frame for tile ${tile.x},${tile.y}`)
    const sop = (
      this.slide.instances[frames.instance[slot] as number] as { id: string }
    ).id
    const isJp2 = level.codec === 'image/jp2'
    const isJls = level.codec === 'image/jls'
    const response = await fetch(
      frameUrl(this.series, sop, frames.frame[slot] as number),
      {
        headers: {
          ...this.options.headers?.(),
          // JPEG 2000 / JPEG-LS: ask for the stored bytes; the checks below
          // refuse a server that transcodes anyway rather than mis-decoding.
          Accept:
            isJp2 || isJls
              ? ANY_SYNTAX
              : 'multipart/related; type="image/jpeg"',
        },
        signal,
      },
    )
    const frame = await firstPart(response, 'WSI tile')
    this.host?.addWireBytes(frame.byteLength)
    if (isJp2 && !isJpeg2000(frame))
      throw new Error('WSI tile is not JPEG 2000 (the server transcoded it)')
    if (isJls && sofMarker(frame) !== 0xf7)
      throw new Error('WSI tile is not JPEG-LS (the server transcoded it)')
    return frame
  }

  /** The optical path's ICC profile: inline, else its bulk data; null without one. */
  async fetchIccProfile(signal?: AbortSignal): Promise<Uint8Array | null> {
    const icc = this.slide.iccProfile
    if (icc?.data) return icc.data
    if (!icc?.bulkDataURI) return null
    const url = this.bulkUrl(icc.bulkDataURI)
    const { retrieveBulkData, headers } = this.options
    if (retrieveBulkData) {
      const data = await retrieveBulkData(url, signal)
      if (data.byteLength > MAX_BODY)
        throw new Error(`ICC profile of ${data.byteLength} bytes`)
      return data instanceof Uint8Array ? data : new Uint8Array(data)
    }
    // Auth goes only to the server it is for, not to a bulk host elsewhere.
    const sameOrigin = new URL(url).origin === this.series.origin
    const response = await fetch(url, {
      headers: {
        ...(sameOrigin ? headers?.() : {}),
        Accept: 'multipart/related; type="application/octet-stream"',
      },
      signal,
    })
    return firstPart(response, 'ICC profile')
  }
}

/** WADO-RS frame URL; the series query (an access token) is kept. */
function frameUrl(
  { origin, pathname, search }: URL,
  sop: string,
  frame: number,
): string {
  return `${origin}${pathname}/instances/${encodeURIComponent(sop)}/frames/${frame}${search}`
}

/** seriesUrl resolved against the page, without trailing slashes, as paths are appended to it. */
function seriesOf(seriesUrl: string): URL {
  const url = new URL(seriesUrl, globalThis.location?.href)
  url.pathname = url.pathname.replace(/\/+$/, '')
  return url
}
