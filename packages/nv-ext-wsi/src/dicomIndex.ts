// Index a local folder of DICOM-WSI instances for tile playback (plan D17/D18).
// Reads only headers and item tags with File.slice, never pixel data, and
// records each frame's byte span, so DicomWsiSource can read one tile at a time.
// Explicit VR little endian only, which covers every WSI transfer syntax.

/** Why an input file was left out of the index. */
export type SlideIndexSkipReason =
  | 'not-dicom' // no DICM preamble
  | 'transfer-syntax' // implicit VR, big endian or deflated
  | 'uncompressed' // native pixel data: no tile codec reads it
  | 'malformed' // a header or item that does not parse
  | 'not-tiled' // no tile geometry (not WSI)

export interface SlideIndexSkipped {
  file: string
  reason: SlideIndexSkipReason
  message: string
}

export interface SlideIndexInstance {
  /** SOPInstanceUID: stable, never an array position or file name alone. */
  id: string
  /** File key: `webkitRelativePath` when set, else `name`. */
  file: string
  /** Bytes; with `version`, binds the index to the file it read. */
  size: number
  /** `lastModified` of the file read. */
  version: string
  transferSyntax: string
  photometric: string
  bitsStored: number
}

export interface SlideIndexFrames {
  /** Index into `SlideIndexSlide.instances`. */
  instance: Uint16Array
  /** One-based DICOM frame number within that instance. */
  frame: Uint32Array
  /** Absolute byte offset of the frame's first payload (its item header excluded). */
  offset: Float64Array
  /**
   * Bytes from `offset` to the end of the frame's last fragment. More than one
   * fragment means item headers inside the span, which DicomWsiSource strips.
   */
  length: Uint32Array
}

export interface SlideIndexLevel {
  width: number
  height: number
  tileWidth: number
  tileHeight: number
  columns: number
  rows: number
  /** Indices into `SlideIndexSlide.instances`, in concatenation order. */
  instances: number[]
  /** `columns * rows`, row-major: a frame slot, or -1 for a hole. */
  tile: Int32Array
  frames: SlideIndexFrames
  /** Frames dropped because another frame already holds their tile (an error). */
  duplicates: number
  /** True when tiles are placed by per-frame position (TILED_SPARSE). */
  sparse: boolean
}

export interface SlideIndexSlide {
  study: string
  series: string
  frameOfReference: string
  container?: string
  /** OpticalPathIdentifier; several paths make several slides. */
  opticalPath: string
  /** ZOffsetInSlideCoordinateSystem (µm) when stated, else the focal-plane index. */
  focalPlane: number
  /** Level-0 pixel spacing in mm, [column, row]. */
  pixelSpacingMM?: [number, number]
  /** The optical path's ICC profile in the level-0 file (not applied yet). */
  iccProfile?: { offset: number; length: number; colorSpace?: string }
  instances: SlideIndexInstance[]
  /** Finest first. */
  levels: SlideIndexLevel[]
}

export interface SlideIndex {
  version: 1
  producer: string
  slides: SlideIndexSlide[]
  skipped: SlideIndexSkipped[]
}

const UNDEFINED_LENGTH = 0xffffffff
const tagOf = (g: number, e: number): number => ((g << 16) | e) >>> 0
const T = {
  transferSyntax: tagOf(0x0002, 0x0010),
  imageType: tagOf(0x0008, 0x0008),
  sop: tagOf(0x0008, 0x0018),
  study: tagOf(0x0020, 0x000d),
  series: tagOf(0x0020, 0x000e),
  frameOfReference: tagOf(0x0020, 0x0052),
  organization: tagOf(0x0020, 0x9311),
  concatUID: tagOf(0x0020, 0x9161),
  concatNumber: tagOf(0x0020, 0x9162),
  concatOffset: tagOf(0x0020, 0x9228),
  photometric: tagOf(0x0028, 0x0004),
  frames: tagOf(0x0028, 0x0008),
  rows: tagOf(0x0028, 0x0010),
  columns: tagOf(0x0028, 0x0011),
  spacing: tagOf(0x0028, 0x0030),
  bitsStored: tagOf(0x0028, 0x0101),
  iccProfile: tagOf(0x0028, 0x2000),
  colorSpace: tagOf(0x0028, 0x2002),
  container: tagOf(0x0040, 0x0512),
  zOffset: tagOf(0x0040, 0x074a),
  totalColumns: tagOf(0x0048, 0x0006),
  totalRows: tagOf(0x0048, 0x0007),
  opticalPathSeq: tagOf(0x0048, 0x0105),
  opticalPathId: tagOf(0x0048, 0x0106),
  planePosition: tagOf(0x0048, 0x021a),
  columnPosition: tagOf(0x0048, 0x021e),
  rowPosition: tagOf(0x0048, 0x021f),
  opticalPaths: tagOf(0x0048, 0x0302),
  focalPlanes: tagOf(0x0048, 0x0303),
  shared: tagOf(0x5200, 0x9229),
  perFrame: tagOf(0x5200, 0x9230),
  eot: tagOf(0x7fe0, 0x0001),
  eotLengths: tagOf(0x7fe0, 0x0002),
  pixelData: tagOf(0x7fe0, 0x0010),
  item: tagOf(0xfffe, 0xe000),
  itemEnd: tagOf(0xfffe, 0xe00d),
  sequenceEnd: tagOf(0xfffe, 0xe0dd),
}
// VRs whose length field is 4 bytes after 2 reserved bytes (PS3.5 7.1.2).
const LONG_VR = new Set([
  'OB',
  'OD',
  'OF',
  'OL',
  'OV',
  'OW',
  'SQ',
  'SV',
  'UC',
  'UN',
  'UR',
  'UT',
  'UV',
])
// Implicit VR little endian, explicit VR big endian, deflated.
const REFUSED_SYNTAXES = new Set([
  '1.2.840.10008.1.2',
  '1.2.840.10008.1.2.2',
  '1.2.840.10008.1.2.1.99',
])

class Skip extends Error {
  constructor(
    readonly reason: SlideIndexSkipReason,
    message: string,
  ) {
    super(message)
  }
}
// The header runs past the bytes read so far.
class NeedMore extends Error {}

/** Where an element sits, for the visitor: its value and the sequence items above it. */
interface Element {
  tag: number
  vr: string
  offset: number
  length: number
  /** [sequence tag, item index, ...] from the top level down. */
  path: number[]
}

function u16(b: Uint8Array, o: number): number {
  if (o + 2 > b.length) throw new NeedMore()
  return (b[o] as number) | ((b[o + 1] as number) << 8)
}

function u32(b: Uint8Array, o: number): number {
  if (o + 4 > b.length) throw new NeedMore()
  return (
    ((b[o] as number) |
      ((b[o + 1] as number) << 8) |
      ((b[o + 2] as number) << 16) |
      ((b[o + 3] as number) << 24)) >>>
    0
  )
}

/**
 * Visit every element from `o` until `end`, a delimiter, or (at the top level)
 * Pixel Data, whose offset it returns. Sequences recurse with the item index on
 * the path, so a visitor can tell per-frame values apart without building maps.
 */
function walk(
  b: Uint8Array,
  o: number,
  end: number,
  path: number[],
  visit: (e: Element) => void,
): number {
  while (o < end) {
    const tag = tagOf(u16(b, o), u16(b, o + 2))
    if (tag === T.itemEnd || tag === T.sequenceEnd) return o + 8
    if (path.length === 0 && tag === T.pixelData) return o
    const vr = String.fromCharCode(b[o + 4] as number, b[o + 5] as number)
    if (!/^[A-Z]{2}$/.test(vr))
      throw new Skip('malformed', `no explicit VR at byte ${o}`)
    const long = LONG_VR.has(vr)
    const length = long ? u32(b, o + 8) : u16(b, o + 6)
    const value = o + (long ? 12 : 8)
    if (vr === 'SQ' || (vr === 'UN' && length === UNDEFINED_LENGTH)) {
      const stop =
        length === UNDEFINED_LENGTH ? Number.POSITIVE_INFINITY : value + length
      let p = value
      for (let item = 0; p < stop; item++) {
        const itemTag = tagOf(u16(b, p), u16(b, p + 2))
        if (itemTag === T.sequenceEnd) {
          p += 8
          break
        }
        if (itemTag !== T.item)
          throw new Skip('malformed', `no item at byte ${p}`)
        const itemLength = u32(b, p + 4)
        const itemEnd =
          itemLength === UNDEFINED_LENGTH
            ? Number.POSITIVE_INFINITY
            : p + 8 + itemLength
        const after = walk(b, p + 8, itemEnd, [...path, tag, item], visit)
        p = itemLength === UNDEFINED_LENGTH ? after : itemEnd
      }
      o = p
      continue
    }
    if (length === UNDEFINED_LENGTH)
      throw new Skip('malformed', `undefined-length ${vr} at byte ${o}`)
    if (value + length > b.length) throw new NeedMore()
    visit({ tag, vr, offset: value, length, path })
    o = value + length
  }
  return o
}

const text = (b: Uint8Array, e: Element): string =>
  String.fromCharCode(...b.subarray(e.offset, e.offset + e.length)).replace(
    /[\0 ]+$/,
    '',
  )

function numberOf(b: Uint8Array, e: Element): number {
  const v = new DataView(b.buffer, b.byteOffset + e.offset, e.length)
  switch (e.vr) {
    case 'US':
      return v.getUint16(0, true)
    case 'SS':
      return v.getInt16(0, true)
    case 'UL':
      return v.getUint32(0, true)
    case 'SL':
      return v.getInt32(0, true)
    case 'FL':
      return v.getFloat32(0, true)
    case 'FD':
      return v.getFloat64(0, true)
    default:
      return Number(text(b, e).split('\\')[0])
  }
}

/** One instance's header and frame spans. Internal: the index regroups these. */
interface InstanceInfo extends SlideIndexInstance {
  study: string
  series: string
  frameOfReference: string
  container?: string
  volume: boolean
  totalColumns: number
  totalRows: number
  tileWidth: number
  tileHeight: number
  frameCount: number
  sparse: boolean
  opticalPathCount: number
  focalPlaneCount: number
  concatNumber: number
  concatOffset: number
  pixelSpacingMM?: [number, number]
  /** OpticalPathSequence identifiers, and each path's ICC profile. */
  pathIds: string[]
  icc: ({ offset: number; length: number; colorSpace?: string } | undefined)[]
  /** Per frame (absent without per-frame positions): tile column/row, path index, Z. */
  column?: Int32Array
  row?: Int32Array
  path?: Uint16Array
  z?: Float64Array
  offset: Float64Array
  length: Uint32Array
}

type ReadAt = (offset: number, length: number) => Promise<Uint8Array>

const fileKey = (f: File): string => f.webkitRelativePath || f.name

async function readHeader(
  readAt: ReadAt,
  size: number,
): Promise<{ b: Uint8Array; pixel: number; elements: Element[] }> {
  let want = Math.min(size, 1 << 20)
  let b: Uint8Array = new Uint8Array(0)
  for (;;) {
    // Grow the prefix by reading only the new bytes.
    const more = await readAt(b.length, want - b.length)
    const grown = new Uint8Array(want)
    grown.set(b)
    grown.set(more, b.length)
    b = grown
    const elements: Element[] = []
    try {
      if (String.fromCharCode(...b.subarray(128, 132)) !== 'DICM')
        throw new Skip('not-dicom', 'no DICM preamble')
      const pixel = walk(b, 132, Number.POSITIVE_INFINITY, [], (e) =>
        elements.push(e),
      )
      if (pixel + 20 > b.length) throw new NeedMore() // Pixel Data and the BOT item header
      return { b, pixel, elements }
    } catch (err) {
      // The file meta group is always explicit VR little endian, so its transfer
      // syntax is known even when the data set after it does not parse.
      const ts = elements.find((e) => e.tag === T.transferSyntax)
      if (ts && REFUSED_SYNTAXES.has(text(b, ts)))
        throw new Skip(
          'transfer-syntax',
          `transfer syntax ${text(b, ts)} is not explicit VR little endian`,
        )
      if (!(err instanceof NeedMore)) throw err
      if (want >= size)
        throw new Skip('not-tiled', 'no Pixel Data (e.g. a DICOMDIR)')
      want = Math.min(size, want * 4)
    }
  }
}

async function indexInstance(file: File): Promise<InstanceInfo> {
  const size = file.size
  const readAt: ReadAt = async (offset, length) =>
    new Uint8Array(await file.slice(offset, offset + length).arrayBuffer())
  const { b, pixel, elements } = await readHeader(readAt, size)
  const top = new Map<number, Element>()
  const pathIds: string[] = []
  const icc: InstanceInfo['icc'] = []
  const colorSpaces: (string | undefined)[] = []
  let sharedSpacing: string | undefined
  let sharedPath: string | undefined
  let sharedZ: number | undefined
  let perFrame = 0
  for (const e of elements) {
    const p = e.path
    if (p.length === 0) top.set(e.tag, e)
    else if (p[0] === T.opticalPathSeq && p.length === 2) {
      const i = p[1] as number
      if (e.tag === T.opticalPathId) pathIds[i] = text(b, e)
      if (e.tag === T.iccProfile)
        icc[i] = { offset: e.offset, length: e.length }
      if (e.tag === T.colorSpace) colorSpaces[i] = text(b, e)
    } else if (p[0] === T.shared) {
      if (e.tag === T.spacing) sharedSpacing = text(b, e)
      if (e.tag === T.opticalPathId) sharedPath = text(b, e)
      if (e.tag === T.zOffset) sharedZ = numberOf(b, e)
    } else if (p[0] === T.perFrame)
      perFrame = Math.max(perFrame, (p[1] as number) + 1)
  }
  icc.forEach((v, i) => {
    if (v && colorSpaces[i]) v.colorSpace = colorSpaces[i]
  })
  const str = (tag: number): string => {
    const e = top.get(tag)
    return e ? text(b, e) : ''
  }
  const num = (tag: number): number | undefined => {
    const e = top.get(tag)
    return e ? numberOf(b, e) : undefined
  }
  const transferSyntax = str(T.transferSyntax)
  if (REFUSED_SYNTAXES.has(transferSyntax))
    throw new Skip(
      'transfer-syntax',
      `transfer syntax ${transferSyntax} is not explicit VR little endian`,
    )
  const frameCount = num(T.frames) ?? 1
  const tileWidth = num(T.columns) ?? 0
  const tileHeight = num(T.rows) ?? 0
  if (!tileWidth || !tileHeight) throw new Skip('not-tiled', 'no Rows/Columns')
  const sparse = str(T.organization) === 'TILED_SPARSE'
  const info: InstanceInfo = {
    id: str(T.sop),
    file: fileKey(file),
    size,
    version: String(file.lastModified),
    transferSyntax,
    photometric: str(T.photometric),
    bitsStored: num(T.bitsStored) ?? 8,
    study: str(T.study),
    series: str(T.series),
    frameOfReference: str(T.frameOfReference),
    container: str(T.container) || undefined,
    volume: str(T.imageType).includes('VOLUME'),
    totalColumns: num(T.totalColumns) ?? tileWidth,
    totalRows: num(T.totalRows) ?? tileHeight,
    tileWidth,
    tileHeight,
    frameCount,
    sparse,
    opticalPathCount: num(T.opticalPaths) ?? 1,
    focalPlaneCount: num(T.focalPlanes) ?? 1,
    concatNumber: num(T.concatNumber) ?? 0,
    concatOffset: num(T.concatOffset) ?? 0,
    pathIds,
    icc,
    offset: new Float64Array(frameCount),
    length: new Uint32Array(frameCount),
  }
  if (sharedSpacing) {
    const [row, column] = sharedSpacing.split('\\').map(Number)
    info.pixelSpacingMM = [column as number, row as number]
  }
  if (perFrame) {
    // Per-frame positions: TILED_SPARSE always, TILED_FULL sometimes.
    if (perFrame !== frameCount)
      throw new Skip(
        'malformed',
        `${perFrame} per-frame items for ${frameCount} frames`,
      )
    const column = new Int32Array(frameCount).fill(-1)
    const row = new Int32Array(frameCount).fill(-1)
    const path = new Uint16Array(frameCount)
    const z = new Float64Array(frameCount).fill(sharedZ ?? 0)
    const sharedIndex = Math.max(0, pathIds.indexOf(sharedPath ?? ''))
    path.fill(sharedIndex)
    for (const e of elements) {
      if (e.path[0] !== T.perFrame) continue
      const f = e.path[1] as number
      if (e.tag === T.columnPosition)
        column[f] = (numberOf(b, e) - 1) / tileWidth
      else if (e.tag === T.rowPosition)
        row[f] = (numberOf(b, e) - 1) / tileHeight
      else if (e.tag === T.zOffset) z[f] = numberOf(b, e)
      else if (e.tag === T.opticalPathId)
        path[f] = Math.max(0, pathIds.indexOf(text(b, e)))
    }
    Object.assign(info, { column, row, path, z })
  } else if (sparse)
    throw new Skip('malformed', 'TILED_SPARSE without per-frame positions')
  await frameSpans(info, b, pixel, top, readAt)
  return info
}

/** Fill `info.offset`/`info.length` from the encapsulated pixel data. */
async function frameSpans(
  info: InstanceInfo,
  b: Uint8Array,
  pixel: number,
  top: Map<number, Element>,
  readAt: ReadAt,
): Promise<void> {
  const { frameCount, offset, length, size } = info
  if (u32(b, pixel + 8) !== UNDEFINED_LENGTH)
    throw new Skip('uncompressed', 'native (uncompressed) pixel data')
  const botLength = u32(b, pixel + 16)
  const first = pixel + 20 + botLength // the first fragment's item header
  const itemHeader = async (
    p: number,
  ): Promise<{ tag: number; length: number }> => {
    const h = await readAt(p, 8)
    return { tag: tagOf(u16(h, 0), u16(h, 2)), length: u32(h, 4) }
  }
  const eot = top.get(T.eot)
  const eotLengths = top.get(T.eotLengths)
  if (eot && eotLengths) {
    // Extended Offset Table: one fragment per frame, 64-bit offsets from the first item.
    const o = new DataView(b.buffer, b.byteOffset + eot.offset, eot.length)
    const l = new DataView(
      b.buffer,
      b.byteOffset + eotLengths.offset,
      eotLengths.length,
    )
    for (let f = 0; f < frameCount; f++) {
      offset[f] = first + Number(o.getBigUint64(8 * f, true)) + 8
      length[f] = Number(l.getBigUint64(8 * f, true))
    }
    return
  }
  if (botLength === 4 * frameCount) {
    // Basic Offset Table: each span runs to the next frame's item header; the
    // last runs to the sequence delimiter. DicomWsiSource verifies the item tag.
    const bot = await readAt(pixel + 20, botLength)
    for (let f = 0; f < frameCount; f++) offset[f] = first + u32(bot, 4 * f) + 8
    for (let f = 0; f + 1 < frameCount; f++)
      length[f] = (offset[f + 1] as number) - 8 - (offset[f] as number)
    let p = (offset[frameCount - 1] as number) - 8
    for (;;) {
      const h = await itemHeader(p)
      if (h.tag !== T.item) break
      p += 8 + h.length
    }
    length[frameCount - 1] = p - (offset[frameCount - 1] as number)
    return
  }
  // No table: walk the items. A frame starts at a fragment that starts a
  // codestream (several fragments may make one frame; never assume item == frame).
  // After a small fragment, the next headers are read as one 64 KiB block;
  // after a large one, just the 12 bytes, so a walk never reads the payloads.
  let block: Uint8Array = new Uint8Array(0)
  let blockStart = 0
  let last = 0 // the previous fragment's length
  const header = async (at: number): Promise<Uint8Array> => {
    if (at < blockStart || at + 12 > blockStart + block.length) {
      blockStart = at
      block = await readAt(at, Math.min(last < 4096 ? 1 << 16 : 12, size - at))
    }
    return block.subarray(at - blockStart, at - blockStart + 12)
  }
  let p = first
  let f = -1
  for (;;) {
    const h = await header(p)
    const tag = tagOf(u16(h, 0), u16(h, 2))
    if (tag === T.sequenceEnd) break
    if (tag !== T.item)
      throw new Skip('malformed', `no fragment item at byte ${p}`)
    const n = u32(h, 4)
    last = n
    if (p + 8 + n > size)
      throw new Skip(
        'malformed',
        `fragment past the end of the file at byte ${p}`,
      )
    const starts =
      (h[8] === 0xff && h[9] === 0xd8) || // JPEG and JPEG-LS SOI
      (h[8] === 0xff && h[9] === 0x4f && h[10] === 0xff && h[11] === 0x51) || // J2K SOC SIZ
      (h[8] === 0 && h[9] === 0 && h[10] === 0 && h[11] === 0x0c) // JP2 signature box
    if (starts && f + 1 < frameCount) offset[++f] = p + 8
    if (f < 0)
      throw new Skip(
        'malformed',
        'the first fragment does not start a codestream',
      )
    length[f] = p + 8 + n - (offset[f] as number)
    p += 8 + n
  }
  if (f + 1 !== frameCount)
    throw new Skip('malformed', `${f + 1} codestreams for ${frameCount} frames`)
}

/**
 * Index the DICOM-WSI instances among `files` (e.g. an `<input webkitdirectory>`
 * selection). Files that are not tiled, compressed, explicit-VR DICOM are
 * listed in `skipped`. Only VOLUME instances make levels; each optical path and
 * focal plane is its own slide.
 * ponytail: main thread with async File.slice reads; move to a worker if a
 * folder without offset tables takes over ~1 s to walk.
 */
export async function indexDicomWsi(
  files: readonly File[],
): Promise<SlideIndex> {
  const infos: InstanceInfo[] = []
  const skipped: SlideIndexSkipped[] = []
  for (const file of files) {
    try {
      infos.push(await indexInstance(file))
    } catch (err) {
      if (!(err instanceof Skip || err instanceof NeedMore)) throw err
      const reason = err instanceof Skip ? err.reason : 'malformed'
      skipped.push({ file: fileKey(file), reason, message: err.message })
    }
  }
  return {
    version: 1,
    producer: 'nv-ext-wsi/indexDicomWsi',
    slides: groupSlides(infos),
    skipped,
  }
}

/** Contract 2: a slide is study + series + frame of reference + container + optical path + focal plane. */
function groupSlides(infos: InstanceInfo[]): SlideIndexSlide[] {
  const slides = new Map<string, { slide: SlideIndexSlide; own: Member[] }>()
  for (const info of infos) {
    if (!info.volume) continue
    placeFrames(info)
    const combos = new Set<string>()
    for (let f = 0; f < info.frameCount; f++)
      combos.add(`${info.framePath[f]}|${info.framePlane[f]}`)
    for (const combo of combos) {
      const [pathIndex, plane] = combo.split('|').map(Number) as [
        number,
        number,
      ]
      const opticalPath = info.pathIds[pathIndex] ?? String(pathIndex)
      const key = [
        info.study,
        info.series,
        info.frameOfReference,
        info.container ?? '',
        opticalPath,
        plane,
      ].join('|')
      let entry = slides.get(key)
      if (!entry) {
        const { study, series, frameOfReference, container } = info
        entry = {
          slide: {
            study,
            series,
            frameOfReference,
            container,
            opticalPath,
            focalPlane: plane,
            instances: [],
            levels: [],
          },
          own: [],
        }
        slides.set(key, entry)
      }
      entry.own.push({ info, pathIndex })
    }
  }
  return [...slides.values()].map(({ slide, own }) => {
    // Finest first; a concatenation's parts in order.
    own.sort(
      (a, b) =>
        b.info.totalColumns * b.info.totalRows -
          a.info.totalColumns * a.info.totalRows ||
        a.info.concatNumber - b.info.concatNumber,
    )
    slide.instances = own.map(
      ({
        info: {
          id,
          file,
          size,
          version,
          transferSyntax,
          photometric,
          bitsStored,
        },
      }) => ({
        id,
        file,
        size,
        version,
        transferSyntax,
        photometric,
        bitsStored,
      }),
    )
    const byMatrix = new Map<string, number[]>()
    own.forEach(({ info }, k) => {
      const key = `${info.totalColumns}x${info.totalRows}`
      byMatrix.set(key, [...(byMatrix.get(key) ?? []), k])
    })
    for (const ks of byMatrix.values())
      slide.levels.push(buildLevel(slide, ks, own))
    const l0 = own[0] as Member
    slide.pixelSpacingMM = l0.info.pixelSpacingMM
    slide.iccProfile = l0.info.icc[l0.pathIndex]
    return slide
  })
}

interface Member {
  info: InstanceInfo & { framePath: Uint16Array; framePlane: Float64Array }
  pathIndex: number
}

/**
 * Each frame's optical path index and focal plane. Without per-frame positions,
 * TILED_FULL orders frames by column, row, focal plane, then optical path.
 */
function placeFrames(info: InstanceInfo): asserts info is Member['info'] {
  const n = info.frameCount
  const framePath = info.path ?? new Uint16Array(n)
  const framePlane = info.z ?? new Float64Array(n)
  if (!info.path) {
    const grid =
      Math.ceil(info.totalColumns / info.tileWidth) *
      Math.ceil(info.totalRows / info.tileHeight)
    for (let f = 0; f < n; f++) {
      const g = info.concatOffset + f
      framePlane[f] = Math.floor(g / grid) % info.focalPlaneCount
      framePath[f] = Math.floor(g / (grid * info.focalPlaneCount))
    }
  }
  Object.assign(info, { framePath, framePlane })
}

function buildLevel(
  slide: SlideIndexSlide,
  ks: number[],
  own: Member[],
): SlideIndexLevel {
  const i0 = (own[ks[0] as number] as Member).info
  const columns = Math.ceil(i0.totalColumns / i0.tileWidth)
  const rows = Math.ceil(i0.totalRows / i0.tileHeight)
  const grid = columns * rows
  const tile = new Int32Array(grid).fill(-1)
  const mine = (f: number, m: Member): boolean =>
    m.info.framePath[f] === m.pathIndex &&
    m.info.framePlane[f] === slide.focalPlane
  // Count first, so the frame arrays are sized once.
  let total = 0
  for (const k of ks) {
    const m = own[k] as Member
    for (let f = 0; f < m.info.frameCount; f++) if (mine(f, m)) total++
  }
  const frames: SlideIndexFrames = {
    instance: new Uint16Array(total),
    frame: new Uint32Array(total),
    offset: new Float64Array(total),
    length: new Uint32Array(total),
  }
  let slot = 0
  let duplicates = 0
  for (const k of ks) {
    const m = own[k] as Member
    const { info } = m
    for (let f = 0; f < info.frameCount; f++) {
      if (!mine(f, m)) continue
      const g = (info.concatOffset + f) % grid
      const x = info.column ? (info.column[f] as number) : g % columns
      const y = info.row ? (info.row[f] as number) : Math.floor(g / columns)
      frames.instance[slot] = k
      frames.frame[slot] = f + 1
      frames.offset[slot] = info.offset[f] as number
      frames.length[slot] = info.length[f] as number
      const t = y * columns + x
      // Off the grid, or a second frame for a tile: an error; the first wins.
      if (
        !Number.isInteger(x) ||
        !Number.isInteger(y) ||
        x < 0 ||
        y < 0 ||
        x >= columns ||
        y >= rows ||
        tile[t] !== -1
      )
        duplicates++
      else tile[t] = slot
      slot++
    }
  }
  return {
    width: i0.totalColumns,
    height: i0.totalRows,
    tileWidth: i0.tileWidth,
    tileHeight: i0.tileHeight,
    columns,
    rows,
    instances: ks,
    tile,
    frames,
    duplicates,
    sparse: ks.some((k) => (own[k] as Member).info.sparse) || tile.includes(-1),
  }
}
