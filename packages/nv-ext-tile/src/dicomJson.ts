// Index DICOM-WSI from DICOM JSON metadata (PS3.18 F.2, or dcmjs-naturalized) with dicomIndex's geometry.
import {
  groupSlides,
  type InstanceCore,
  type InstanceInfo,
  instanceGeometry,
  MAX_SLIDE_TILES,
  NUMBER_KEYWORDS,
  REFUSED_SYNTAXES,
  Skip,
  type SlideIndex,
  type SlideIndexFrames,
  type SlideIndexLevel,
  type SlideIndexSkipped,
  type SlideIndexSlide,
  skipOf,
  T,
  TEXT_KEYWORDS,
  type WsiAttributes,
} from './dicomIndex'

export type DicomJsonInstance = InstanceCore & {
  /** Index into the array given to {@link indexDicomWsiMetadata}. */
  input: number
}

/** An optical path's ICC profile: a bulk-data reference to fetch, or the bytes given inline. */
export interface DicomJsonIccProfile {
  bulkDataURI?: string
  data?: Uint8Array
  colorSpace?: string
}

/** A slide indexed from metadata: frames have no byte spans; a source fetches each by number (WADO-RS /frames/{n}). */
export type DicomJsonSlide = Omit<
  SlideIndexSlide,
  'instances' | 'iccProfile' | 'levels'
> & {
  instances: DicomJsonInstance[]
  iccProfile?: DicomJsonIccProfile
  levels: (Omit<SlideIndexLevel, 'frames'> & {
    frames: Omit<SlideIndexFrames, 'offset' | 'length'>
  })[]
}

type Json = Record<string, unknown>

const EXPLICIT_LITTLE = '1.2.840.10008.1.2.1'

const isBulk = (v: unknown): v is Json =>
  typeof v === 'object' &&
  v !== null &&
  ('BulkDataURI' in v || 'InlineBinary' in v)

/**
 * An attribute by keyword (naturalized) or by tag (PS3.18 `{vr, Value}`, tag in
 * upper-case hex): undefined when absent, '' when stated empty (PS3.18 has no
 * Value then), as the byte reader sees a zero-length element. A bulk-data
 * reference comes back whole.
 */
function get(o: unknown, keyword: string, tag: number): unknown {
  if (typeof o !== 'object' || o === null) return undefined
  const json = o as Json
  if (keyword in json) return json[keyword]
  const e = json[tag.toString(16).toUpperCase().padStart(8, '0')]
  if (typeof e !== 'object' || e === null) return undefined
  return isBulk(e) ? e : ((e as Json).Value ?? '')
}

/** Sequence items: an array, or one item given bare; bulk data holds none. */
const items = (v: unknown): Json[] =>
  (Array.isArray(v) ? v : [v]).filter(
    (i): i is Json => typeof i === 'object' && i !== null && !isBulk(i),
  )

/** Values joined by backslash, as in the byte stream; '' when absent. */
const text = (v: unknown): string =>
  v === undefined || v === null
    ? ''
    : Array.isArray(v)
      ? v.map(text).join('\\')
      : String(v)

/** A value as a number (numeric strings too, first of several): undefined when absent, NaN when empty or not a number. */
const num = (v: unknown): number | undefined => {
  if (v === undefined) return undefined
  const s = text(v).split('\\')[0]
  return s ? Number(s) : Number.NaN
}

function iccOf(path: Json): DicomJsonIccProfile | undefined {
  let v = get(path, 'ICCProfile', T.iccProfile)
  if (Array.isArray(v)) v = v[0]
  let icc: DicomJsonIccProfile
  if (v instanceof ArrayBuffer) icc = { data: new Uint8Array(v) }
  else if (ArrayBuffer.isView(v))
    icc = { data: new Uint8Array(v.buffer, v.byteOffset, v.byteLength) }
  else if (isBulk(v) && typeof v.BulkDataURI === 'string')
    icc = { bulkDataURI: v.BulkDataURI }
  else if (isBulk(v) && typeof v.InlineBinary === 'string') {
    let s: string
    try {
      s = atob(v.InlineBinary)
    } catch {
      return undefined // a bad profile loses colour management, not the slide
    }
    const data = new Uint8Array(s.length)
    for (let i = 0; i < s.length; i++) data[i] = s.charCodeAt(i)
    icc = { data }
  } else return undefined
  const colorSpace = text(get(path, 'ColorSpace', T.colorSpace))
  return colorSpace ? { ...icc, colorSpace } : icc
}

function readAttributes(o: unknown): WsiAttributes<DicomJsonIccProfile> {
  const first = (v: unknown, keyword: string, tag: number) =>
    items(get(v, keyword, tag))[0]
  const measures = (g?: Json) =>
    first(g, 'PixelMeasuresSequence', T.pixelMeasuresSeq)
  const position = (g?: Json) =>
    first(g, 'PlanePositionSlideSequence', T.planePositionSeq)
  const pathId = (g?: Json) =>
    get(
      first(g, 'OpticalPathIdentificationSequence', T.opticalPathIdSeq),
      'OpticalPathIdentifier',
      T.opticalPathId,
    )
  const spacing = (g?: Json) => {
    const s = text(get(g, 'PixelSpacing', T.spacing))
    return s ? s.split('\\').map(Number) : undefined
  }
  // ZOffset is DS: a file's empty value reads Number('') = 0, so a stated-empty one here does too.
  const zOffset = (g?: Json) => {
    const v = get(position(g), 'ZOffsetInSlideCoordinateSystem', T.zOffset)
    return v === '' ? 0 : num(v)
  }
  const shared = first(o, 'SharedFunctionalGroupsSequence', T.shared)
  const perFrame = items(get(o, 'PerFrameFunctionalGroupsSequence', T.perFrame))
  const paths = items(get(o, 'OpticalPathSequence', T.opticalPathSeq))
  const a: WsiAttributes<DicomJsonIccProfile> = {
    text: {},
    number: {},
    spacing: [
      spacing(measures(shared)),
      spacing(measures(perFrame[0])),
      spacing(o as Json),
    ],
    pathIds: [],
    icc: paths.map(iccOf),
    sharedZ: zOffset(shared),
    perFrame: perFrame.length,
    column: [],
    row: [],
    z: [],
    path: [],
  }
  // A path without an identifier stays a hole, named by its index, as in a file.
  paths.forEach((p, i) => {
    const id = get(p, 'OpticalPathIdentifier', T.opticalPathId)
    if (id !== undefined) a.pathIds[i] = text(id)
  })
  const sharedPath = pathId(shared)
  if (sharedPath !== undefined) a.sharedPath = text(sharedPath)
  perFrame.forEach((g, f) => {
    const p = position(g)
    a.column[f] = num(
      get(p, 'ColumnPositionInTotalImagePixelMatrix', T.columnPosition),
    )
    a.row[f] = num(get(p, 'RowPositionInTotalImagePixelMatrix', T.rowPosition))
    a.z[f] = zOffset(g)
    const id = pathId(g)
    a.path[f] = id === undefined ? undefined : text(id)
  })
  for (const [tag, keyword] of Object.entries(TEXT_KEYWORDS)) {
    const v = get(o, keyword, Number(tag))
    if (v !== undefined) a.text[Number(tag)] = text(v)
  }
  // A WADO-RS /metadata response states AvailableTransferSyntaxUID, not the
  // file meta TransferSyntaxUID; neither leaves '' for the source to resolve.
  // A transcoding server may list several: take the first a tile codec reads.
  const available = text(
    get(o, 'AvailableTransferSyntaxUID', T.availableTransferSyntax),
  ).split('\\')
  a.text[T.transferSyntax] ||=
    available.find(
      (ts) => !REFUSED_SYNTAXES.has(ts) && ts !== EXPLICIT_LITTLE,
    ) ?? (available[0] as string)
  for (const [tag, keyword] of Object.entries(NUMBER_KEYWORDS)) {
    const v = num(get(o, keyword, Number(tag)))
    if (v !== undefined) a.number[Number(tag)] = v
  }
  return a
}

/**
 * Index DICOM-WSI instances from their metadata, as {@link indexDicomWsi} does
 * local files: the same slides, levels and tile placement, with each frame
 * named by instance and frame number. Accepts PS3.18 DICOM JSON and
 * dcmjs-naturalized objects. Instances it cannot index are in `skipped`, named
 * by SOPInstanceUID (or `instances[k]`). Unlike files, one call indexes at
 * most `MAX_SLIDE_TILES` frames in total, so a huge z-stack loses levels.
 */
export function indexDicomWsiMetadata(
  instances: readonly unknown[],
): Omit<SlideIndex, 'slides'> & { slides: DicomJsonSlide[] } {
  const infos: InstanceInfo<DicomJsonInstance, DicomJsonIccProfile>[] = []
  const skipped: SlideIndexSkipped[] = []
  // Metadata is not bounded by a file size, so the frames of one call are
  // bounded by what a slide may show (about 100 bytes per frame indexed).
  let frames = 0
  instances.forEach((o, input) => {
    let name = `instances[${input}]`
    try {
      name = text(get(o, 'SOPInstanceUID', T.sop)) || name
      const a = readAttributes(o)
      const left = MAX_SLIDE_TILES - frames
      const stated = a.number[T.frames] ?? 1
      if (stated > left)
        throw new Skip(
          'malformed',
          `NumberOfFrames ${stated} is past the ${left} left of ${MAX_SLIDE_TILES} for one call`,
        )
      const g = instanceGeometry(a, left)
      // Same reasons as a local file's: no tile codec reads native pixel data.
      const ts = g.instance.transferSyntax
      if (REFUSED_SYNTAXES.has(ts))
        throw new Skip(
          'transfer-syntax',
          `transfer syntax ${ts} is not explicit VR little endian`,
        )
      if (ts === EXPLICIT_LITTLE)
        throw new Skip('uncompressed', 'native (uncompressed) pixel data')
      infos.push({ ...g, instance: { ...g.instance, input } })
      frames += g.frameCount
    } catch (err) {
      skipped.push(skipOf(name, err))
    }
  })
  const slides = groupSlides(
    infos,
    skipped,
    (i) => i.id || `instances[${i.input}]`,
  ).map((slide) => ({
    ...slide,
    levels: slide.levels.map(
      ({ frames: { offset: _o, length: _l, ...frames }, ...level }) => ({
        ...level,
        frames,
      }),
    ),
  }))
  return {
    version: 1,
    producer: 'nv-ext-tile/indexDicomWsiMetadata',
    slides,
    skipped,
  }
}
