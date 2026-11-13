import type {
  NVSlideAttribution,
  NVSlideLevelManifest,
  NVSlideManifest,
  NVSlideTileManifest,
  SlideFetch,
  SlideSourceHost,
  SlideTileSource,
} from '@niivue/niivue'
import { cleanAttribution } from './attribution'
import type { DicomJsonSlide } from './dicomJson'
import { levelMaps } from './dicomOrientation'
import { manifestOf } from './dicomWsiSource'
import { parseMultipartRelated } from './multipart'
import { anySignal, MAX_BODY, readOk, slideFetch } from './rangeFetch'

const ANY_SYNTAX =
  'multipart/related; type="application/octet-stream"; transfer-syntax=*'

export interface DicomWebWsiOptions {
  /** The series' WADO-RS URL: `{wadoRoot}/studies/{study}/series/{series}`. */
  seriesUrl: string
  /**
   * Fetches every request to the seriesUrl origin, e.g. one that adds auth.
   * URLs on other origins (an ICC BulkDataURI elsewhere) use globalThis.fetch,
   * so a caller's credentials never leave the series' origin.
   */
  fetch?: SlideFetch
  /** Credit for the slide, as `manifest.attribution`. */
  attribution?: NVSlideAttribution
  /**
   * Fetches ICC bulk data by its resolved URL (e.g. OHIF's
   * dataSource.retrieve.bulkDataURI), for URLs on the series' origin only;
   * otherwise, without it, or when it resolves undefined or empty, fetch.
   */
  retrieveBulkData?: (
    url: string,
    signal?: AbortSignal,
  ) => Promise<ArrayBuffer | Uint8Array | undefined>
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

/**
 * The first part of a WADO-RS (multipart/related) response, or the whole body
 * if it is not multipart. Throws on a non-OK status, an empty part or a body
 * past `max` bytes (64 MB by default); `what` names the resource in those errors.
 */
export async function readFirstPart(
  response: Response,
  what: string,
  max = MAX_BODY,
): Promise<Uint8Array> {
  const body = await readOk(response, what, max)
  const part = parseMultipartRelated(
    body,
    response.headers.get('content-type') ?? '',
  )[0]
  if (!part?.length) throw new Error(`empty ${what} body`)
  return part
}

// Statuses by which a server refuses the any-syntax Accept itself.
const REFUSED_ACCEPT = new Set([400, 406, 415])

/**
 * A level's transfer syntax from one of its frames. A server that refuses
 * untranscoded frames (400, 406, 415) gets JPEG Baseline, as nv-ohif assumed
 * before; its tiles are then asked for as image/jpeg. Other statuses (auth,
 * missing, server errors), aborts and network errors reject.
 */
async function sniffLevel(
  fetchImpl: SlideFetch,
  url: string,
  signal?: AbortSignal,
): Promise<string> {
  const response = await fetchImpl(url, {
    headers: { Accept: ANY_SYNTAX },
    signal,
  })
  if (REFUSED_ACCEPT.has(response.status)) {
    await response.body?.cancel()
    return '1.2.840.10008.1.2.4.50'
  }
  return sniffSyntax(await readFirstPart(response, 'WSI frame'))
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
  private readonly closed = new AbortController()

  private constructor(
    readonly slide: DicomJsonSlide,
    private readonly options: DicomWebWsiOptions,
  ) {
    this.maps = levelMaps(slide)
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
    const attribution = cleanAttribution(options.attribution)
    if (attribution) this.manifest.attribution = attribution
  }

  /** The series-origin fetch: the caller's, else globalThis.fetch (bound: a bare one throws "Illegal invocation"). */
  private get seriesFetch(): SlideFetch {
    return seriesFetchOf(this.options)
  }

  /** Every read also stops on dispose; after it, none reaches fetch. */
  private signalOf(signal?: AbortSignal): AbortSignal | undefined {
    this.closed.signal.throwIfAborted()
    return anySignal(signal, this.closed.signal)
  }

  /**
   * The source for `slide`. A level whose metadata states no transfer syntax
   * costs one frame request here, all levels at once, to read it from the bytes.
   */
  static async open(
    slide: DicomJsonSlide,
    options: DicomWebWsiOptions,
    signal?: AbortSignal,
  ): Promise<DicomWebWsiSource> {
    const instances = slide.instances.map((i) => ({ ...i }))
    const series = seriesOf(options.seriesUrl)
    // Concurrent: first paint waits one round trip, not one per level.
    await Promise.all(
      slide.levels.map(async (level) => {
        const i = level.frames.instance[0]
        const frame = level.frames.frame[0]
        const inst = instances[i as number]
        if (!inst || inst.transferSyntax || frame === undefined) return
        const ts = await sniffLevel(
          seriesFetchOf(options),
          frameUrl(series, inst.id, frame),
          signal,
        )
        for (const k of level.instances)
          (instances[k] as typeof inst).transferSyntax = ts
      }),
    )
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
    const response = await this.seriesFetch(
      frameUrl(this.series, sop, frames.frame[slot] as number),
      {
        headers: {
          // JPEG 2000 / JPEG-LS: ask for the stored bytes; the checks below
          // refuse a server that transcodes anyway rather than mis-decoding.
          Accept:
            isJp2 || isJls
              ? ANY_SYNTAX
              : 'multipart/related; type="image/jpeg"',
        },
        signal: this.signalOf(signal),
      },
    )
    const frame = await readFirstPart(response, 'WSI tile')
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
    const { retrieveBulkData } = this.options
    const abort = this.signalOf(signal)
    // Auth goes only to the server it is for, not to a bulk host elsewhere:
    // the host's retrieval and fetch carry its auth, so they get same-origin URLs only.
    const sameOrigin = new URL(url).origin === this.series.origin
    const data = sameOrigin ? await retrieveBulkData?.(url, abort) : undefined
    abort?.throwIfAborted()
    if (data?.byteLength) {
      if (data.byteLength > MAX_BODY)
        throw new Error(`ICC profile of ${data.byteLength} bytes`)
      return data instanceof Uint8Array ? data : new Uint8Array(data)
    }
    const response = await (sameOrigin ? this.seriesFetch : slideFetch())(url, {
      headers: { Accept: 'multipart/related; type="application/octet-stream"' },
      signal: abort,
    })
    return readFirstPart(response, 'ICC profile')
  }

  /** Abort in-flight reads; later reads reject AbortError. Idempotent. */
  dispose(): void {
    this.closed.abort()
  }
}

const seriesFetchOf = (options: DicomWebWsiOptions): SlideFetch =>
  slideFetch(options.fetch)

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
