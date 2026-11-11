// Index a local folder of DICOM-WSI instances for tile playback (plan D17/D18).
// Reads only headers and item tags with File.slice, never pixel data, and
// records each frame's byte span, so DicomWsiSource can read one tile at a time.
// Explicit VR little endian only, which covers every WSI transfer syntax.
// Files are untrusted: every size taken from a header is checked against the
// file before it sizes an allocation or a read.

/** Why an input file was left out of the index. */
export type SlideIndexSkipReason =
  | 'not-dicom' // no DICM preamble
  | 'transfer-syntax' // implicit VR, big endian or deflated
  | 'uncompressed' // native pixel data: no tile codec reads it
  | 'malformed' // a header or item that does not parse, or a value out of range
  | 'too-large' // a level of more tiles than the index holds
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
  instance: Uint32Array
  /** One-based DICOM frame number within that instance. */
  frame: Uint32Array
  /** Absolute byte offset of the frame's first payload (its item header excluded). */
  offset: Float64Array
  /**
   * Bytes from `offset` to the end of the frame's last fragment. More than one
   * fragment means item headers inside the span, which DicomWsiSource strips.
   */
  length: Uint32Array
  /** Row-major tile the frame claims, or -1 when its position is invalid or off the grid. */
  tile: Int32Array
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
  frames: SlideIndexFrames
  /** Frames dropped because another frame already holds their tile, or their position is off the grid (an error). */
  duplicates: number
  /** Tiles no frame fills. */
  holes: number
  /** True when tiles are placed by per-frame position (TILED_SPARSE). */
  sparse: boolean
}

export interface SlideIndexIccProfile {
  offset: number
  length: number
  colorSpace?: string
}

export interface SlideIndexSlide {
  study: string
  series: string
  frameOfReference: string
  container?: string
  /** OpticalPathIdentifier; several paths make several slides. */
  opticalPath: string
  /** Focal-plane index, not µm: the TILED_FULL plane index, or the rank
   * (0 = lowest) of the stated ZOffsets across the slide's levels. */
  focalPlane: number
  /** Level-0 pixel spacing in mm, [column, row]. */
  pixelSpacingMM?: [number, number]
  /** The optical path's ICC profile in the level-0 file. */
  iccProfile?: SlideIndexIccProfile
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

/** The key a file is indexed and looked up by: `webkitRelativePath` when set, else `name`. */
export const fileKey = (f: File): string => f.webkitRelativePath || f.name

const UNDEFINED_LENGTH = 0xffffffff
// Hostile-input bounds. No WSI header nests sequences deeper than 4, the
// largest corpus header is 15 MB, and the largest level grid is 379k tiles.
const MAX_DEPTH = 8
const MAX_HEADER = 64 << 20
// NiiVue's MAX_SLIDE_GRID, pinned by a test: this parser imports nothing,
// so the manifest CLI runs without loading NiiVue.
const MAX_GRID = 1 << 22
export const MAX_SLIDE_TILES = 2 * MAX_GRID
// (Optical path, focal plane) pairs in one file, each a slide. Real files have
// a few paths and tens of planes; a multiplexed z-stack a few hundred.
const MAX_PAIRS = 4096
const VR_BYTES: Record<string, number> = { US: 2, UL: 4, SL: 4, FL: 4, FD: 8 }
const tagOf = (g: number, e: number): number => ((g << 16) | e) >>> 0
export const T = {
  transferSyntax: tagOf(0x0002, 0x0010),
  availableTransferSyntax: tagOf(0x0008, 0x3002),
  imageType: tagOf(0x0008, 0x0008),
  sop: tagOf(0x0008, 0x0018),
  study: tagOf(0x0020, 0x000d),
  series: tagOf(0x0020, 0x000e),
  frameOfReference: tagOf(0x0020, 0x0052),
  organization: tagOf(0x0020, 0x9311),
  concatNumber: tagOf(0x0020, 0x9162),
  concatOffset: tagOf(0x0020, 0x9228),
  photometric: tagOf(0x0028, 0x0004),
  frames: tagOf(0x0028, 0x0008),
  rows: tagOf(0x0028, 0x0010),
  columns: tagOf(0x0028, 0x0011),
  spacing: tagOf(0x0028, 0x0030),
  bitsStored: tagOf(0x0028, 0x0101),
  iccProfile: tagOf(0x0028, 0x2000),
  pixelMeasuresSeq: tagOf(0x0028, 0x9110),
  colorSpace: tagOf(0x0028, 0x2002),
  container: tagOf(0x0040, 0x0512),
  zOffset: tagOf(0x0040, 0x074a),
  volumeWidth: tagOf(0x0048, 0x0001),
  volumeHeight: tagOf(0x0048, 0x0002),
  totalColumns: tagOf(0x0048, 0x0006),
  totalRows: tagOf(0x0048, 0x0007),
  opticalPathSeq: tagOf(0x0048, 0x0105),
  opticalPathId: tagOf(0x0048, 0x0106),
  opticalPathIdSeq: tagOf(0x0048, 0x0207),
  planePositionSeq: tagOf(0x0048, 0x021a),
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
/** Top-level attributes instanceGeometry reads, by tag: their DICOM JSON keywords. */
export const TEXT_KEYWORDS: Record<number, string> = {
  [T.transferSyntax]: 'TransferSyntaxUID',
  [T.imageType]: 'ImageType',
  [T.sop]: 'SOPInstanceUID',
  [T.study]: 'StudyInstanceUID',
  [T.series]: 'SeriesInstanceUID',
  [T.frameOfReference]: 'FrameOfReferenceUID',
  [T.organization]: 'DimensionOrganizationType',
  [T.photometric]: 'PhotometricInterpretation',
  [T.container]: 'ContainerIdentifier',
}
export const NUMBER_KEYWORDS: Record<number, string> = {
  [T.concatNumber]: 'InConcatenationNumber',
  [T.concatOffset]: 'ConcatenationFrameOffsetNumber',
  [T.frames]: 'NumberOfFrames',
  [T.rows]: 'Rows',
  [T.columns]: 'Columns',
  [T.bitsStored]: 'BitsStored',
  [T.volumeWidth]: 'ImagedVolumeWidth',
  [T.volumeHeight]: 'ImagedVolumeHeight',
  [T.totalColumns]: 'TotalPixelMatrixColumns',
  [T.totalRows]: 'TotalPixelMatrixRows',
  [T.opticalPaths]: 'NumberOfOpticalPaths',
  [T.focalPlanes]: 'TotalPixelMatrixFocalPlanes',
}
// Top-level tags the index reads. Others are walked, not kept, so a header of
// millions of elements costs no heap per element.
const TOP_TAGS = new Set([
  ...Object.keys(TEXT_KEYWORDS).map(Number),
  ...Object.keys(NUMBER_KEYWORDS).map(Number),
  T.spacing,
  T.eot,
  T.eotLengths,
])
// Each two-letter VR by its bytes, so walk allocates no string per element.
const VR_NAMES: string[] = []
for (let i = 65; i <= 90; i++)
  for (let j = 65; j <= 90; j++)
    VR_NAMES[(i << 8) | j] = String.fromCharCode(i, j)
// Longer than any UID, code string or decimal list the index reads; a longer
// value is not decoded (spreading megabytes into fromCharCode costs gigabytes).
const MAX_TEXT = 1024
// VRs whose length field is 4 bytes after 2 reserved bytes (PS3.5 7.1.2).
const LONG_VR = new Set('OB OD OF OL OV OW SQ SV UC UN UR UT UV'.split(' '))
// Implicit VR little endian, explicit VR big endian, deflated.
export const REFUSED_SYNTAXES = new Set([
  '1.2.840.10008.1.2',
  '1.2.840.10008.1.2.2',
  '1.2.840.10008.1.2.1.99',
])

export class Skip extends Error {
  constructor(
    readonly reason: SlideIndexSkipReason,
    message: string,
  ) {
    super(message)
  }
}
// The header runs past the bytes read so far.
class NeedMore extends Error {}

/**
 * An element's value, and where it sits: under which top-level sequence and
 * item (`root`, `item`), how deep. The index needs no more of the path than that.
 */
interface Element {
  tag: number
  vr: string
  offset: number
  length: number
  /** The top-level sequence it is inside (0 at the top level), and that sequence's item index. */
  root: number
  item: number
  depth: number
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

// The one object walk visits, refilled per element (a visitor copies what it
// keeps): an object per element costs hundreds of MB in garbage for a header of
// millions of elements.
const visited: Element = {
  tag: 0,
  vr: '',
  offset: 0,
  length: 0,
  root: 0,
  item: 0,
  depth: 0,
}

/**
 * Visit every element from `o` until `end`, a delimiter, or (at the top level)
 * Pixel Data, whose offset it returns, skipping top-level elements the index
 * does not read. `size` is the file's, so a value that claims to run past the
 * file is malformed, not a reason to read further.
 */
function walk(
  b: Uint8Array,
  o: number,
  end: number,
  size: number,
  at: { root: number; item: number; depth: number },
  visit: (e: Element) => void,
): number {
  while (o < end) {
    // u16/u32 guard the tag and length, but the VR bytes are read directly.
    if (o + 8 > b.length) throw new NeedMore()
    const tag = tagOf(u16(b, o), u16(b, o + 2))
    if (tag === T.itemEnd || tag === T.sequenceEnd) return o + 8
    if (at.depth === 0 && tag === T.pixelData) return o
    const vr = VR_NAMES[((b[o + 4] as number) << 8) | (b[o + 5] as number)]
    if (vr === undefined)
      throw new Skip('malformed', `no explicit VR at byte ${o}`)
    const long = LONG_VR.has(vr)
    const length = long ? u32(b, o + 8) : u16(b, o + 6)
    const value = o + (long ? 12 : 8)
    if (vr === 'UN' && length === UNDEFINED_LENGTH) {
      o = skipImplicitSequence(b, value, size, at.depth + 1)
      continue
    }
    if (vr === 'SQ') {
      if (at.depth >= MAX_DEPTH)
        throw new Skip('malformed', `sequences nested deeper than ${MAX_DEPTH}`)
      const unbounded = length === UNDEFINED_LENGTH
      const stop = unbounded ? size : value + length
      // As for UN: EOF inside a sequence is a truncated file, not a missing Pixel Data.
      if (stop > size)
        throw new Skip('malformed', `SQ at byte ${o} runs past the file`)
      let closed = false
      let p = value
      // One object for all the items, as for elements.
      const inner =
        at.depth === 0
          ? { root: tag, item: 0, depth: 1 }
          : { ...at, depth: at.depth + 1 }
      for (let item = 0; p < stop; item++) {
        const itemTag = tagOf(u16(b, p), u16(b, p + 2))
        const itemLength = u32(b, p + 4)
        if (itemTag === T.sequenceEnd) {
          p += 8
          closed = true
          break
        }
        if (itemTag !== T.item)
          throw new Skip('malformed', `no item at byte ${p}`)
        const itemEnd =
          itemLength === UNDEFINED_LENGTH ? size : p + 8 + itemLength
        if (at.depth === 0) inner.item = item
        const after = walk(b, p + 8, itemEnd, size, inner, visit)
        p = itemLength === UNDEFINED_LENGTH ? after : itemEnd
      }
      if (unbounded && !closed)
        throw new Skip('malformed', `SQ at byte ${o} runs past the file`)
      o = p
      continue
    }
    if (length === UNDEFINED_LENGTH)
      throw new Skip('malformed', `undefined-length ${vr} at byte ${o}`)
    if (value + length > size)
      throw new Skip('malformed', `${vr} at byte ${o} runs past the file`)
    if (value + length > b.length) throw new NeedMore()
    if (at.depth || TOP_TAGS.has(tag)) {
      const e = visited
      e.tag = tag
      e.vr = vr
      e.offset = value
      e.length = length
      e.root = at.root
      e.item = at.item
      e.depth = at.depth
      visit(e)
    }
    o = value + length
  }
  return o
}

/**
 * Skip an undefined-length UN element's value from `p`: an implicit VR little
 * endian sequence (PS3.5 6.2.2), so its items are stepped over by length, never
 * walked as explicit VR. Returns the offset after its delimiter.
 */
function skipImplicitSequence(
  b: Uint8Array,
  p: number,
  size: number,
  depth: number,
): number {
  if (depth > MAX_DEPTH)
    throw new Skip('malformed', `sequences nested deeper than ${MAX_DEPTH}`)
  for (;;) {
    // EOF before the delimiter: a truncated sequence, not a missing Pixel Data.
    if (p + 8 > size)
      throw new Skip('malformed', 'UN sequence runs past the file')
    const itemTag = tagOf(u16(b, p), u16(b, p + 2))
    const itemLength = u32(b, p + 4)
    p += 8
    if (itemTag === T.sequenceEnd) return p
    if (itemTag !== T.item)
      throw new Skip('malformed', `no item at byte ${p - 8}`)
    if (itemLength !== UNDEFINED_LENGTH) p += itemLength
    else
      for (;;) {
        if (p + 8 > size)
          throw new Skip('malformed', 'UN sequence runs past the file')
        const tag = tagOf(u16(b, p), u16(b, p + 2))
        const length = u32(b, p + 4)
        p += 8
        if (tag === T.itemEnd) break
        p =
          length === UNDEFINED_LENGTH
            ? skipImplicitSequence(b, p, size, depth + 1)
            : p + length
      }
  }
}

function text(b: Uint8Array, e: Element): string {
  if (e.length > MAX_TEXT)
    throw new Skip('malformed', `${e.length}-byte ${e.vr} at byte ${e.offset}`)
  // Built char by char, trailing NUL and space padding trimmed as bytes: a
  // subarray and a spread per value cost hundreds of MB in garbage for
  // millions of per-frame values.
  let end = e.offset + e.length
  while (end > e.offset && (b[end - 1] === 0 || b[end - 1] === 0x20)) end--
  let t = ''
  for (let i = e.offset; i < end; i++) t += String.fromCharCode(b[i] as number)
  return t
}

/**
 * A numeric value: binary for US/UL/SL/FL/FD, else the first value of IS/DS
 * text. NaN when it does not parse. `v` views all of `b`, so no DataView is made
 * per element.
 */
function numberOf(b: Uint8Array, v: DataView, e: Element): number {
  const bytes = VR_BYTES[e.vr]
  if (!bytes) return Number(text(b, e).split('\\')[0])
  if (e.length < bytes) return Number.NaN
  const o = e.offset
  return e.vr === 'US'
    ? v.getUint16(o, true)
    : e.vr === 'UL'
      ? v.getUint32(o, true)
      : e.vr === 'SL'
        ? v.getInt32(o, true)
        : e.vr === 'FL'
          ? v.getFloat32(o, true)
          : v.getFloat64(o, true)
}

/**
 * What the index needs of one instance, from either reader (header bytes or
 * DICOM JSON); {@link instanceGeometry} places its frames. `C` is how the
 * reader locates an ICC profile.
 */
export interface WsiAttributes<C> {
  /** By tag, the attributes in TEXT_KEYWORDS and NUMBER_KEYWORDS that are stated; a number is NaN when it does not parse. */
  text: Record<number, string>
  number: Record<number, number>
  /** PixelSpacing (row, column) candidates, preferred first: shared, the first frame's, top level. */
  spacing: (number[] | undefined)[]
  /** OpticalPathSequence identifiers, and each path's ICC profile. */
  pathIds: string[]
  icc: (C | undefined)[]
  sharedPath?: string
  sharedZ?: number
  /** Per-frame functional group items. */
  perFrame: number
  /** Per frame, when stated: 1-based pixel position, ZOffset (µm), OpticalPathIdentifier. */
  column: (number | undefined)[]
  row: (number | undefined)[]
  z: (number | undefined)[]
  path: (string | undefined)[]
}

/** The instance fields both readers state; each adds how it locates the frames. */
export type InstanceCore = Omit<SlideIndexInstance, 'file' | 'size' | 'version'>

/** One instance's placed frames and, for a local file, their byte spans. Package-internal: the index regroups these. */
export interface InstanceInfo<
  I = SlideIndexInstance,
  C = SlideIndexIccProfile,
> {
  instance: I
  study: string
  series: string
  frameOfReference: string
  container?: string
  volume: boolean
  totalColumns: number
  totalRows: number
  tileWidth: number
  tileHeight: number
  /** Tile grid: columns and rows of tiles. */
  columns: number
  rows: number
  frameCount: number
  sparse: boolean
  concatNumber: number
  pixelSpacingMM?: [number, number]
  /** OpticalPathSequence identifiers, and each path's ICC profile. */
  pathIds: string[]
  icc: (C | undefined)[]
  /** Per frame: tile column and row (-1 when its position is invalid), optical path index, focal plane. */
  column: Int32Array
  row: Int32Array
  path: Uint32Array
  /** µm when `zStated`, else the implicit TILED_FULL plane; groupSlides makes it a rank. */
  z: Float64Array
  zStated: boolean
  /** Per path index, its distinct `z` values (ranked with `z`). */
  planes: Set<number>[]
  /** Local files only (zero otherwise): see SlideIndexFrames. */
  offset: Float64Array
  length: Uint32Array
}

type ReadAt = (offset: number, length: number) => Promise<Uint8Array>

function refuseSyntax(b: Uint8Array, top: Map<number, Element>): void {
  // The file meta group is always explicit VR little endian, so its transfer
  // syntax is known even when the data set after it does not parse.
  const ts = top.get(T.transferSyntax)
  if (ts && REFUSED_SYNTAXES.has(text(b, ts)))
    throw new Skip(
      'transfer-syntax',
      `transfer syntax ${text(b, ts)} is not explicit VR little endian`,
    )
}

async function readHeader(
  readAt: ReadAt,
  size: number,
): Promise<{
  b: Uint8Array
  pixel: number
  top: Map<number, Element>
  attributes: WsiAttributes<SlideIndexIccProfile>
}> {
  let want = Math.min(size, 1 << 20)
  let b: Uint8Array = new Uint8Array(0)
  for (;;) {
    // Grow the prefix by reading only the new bytes.
    const more = await readAt(b.length, want - b.length)
    const grown = new Uint8Array(want)
    grown.set(b)
    grown.set(more, b.length)
    b = grown
    const reader = attributeReader(b)
    const { top } = reader
    try {
      if (String.fromCharCode(...b.subarray(128, 132)) !== 'DICM')
        throw new Skip('not-dicom', 'no DICM preamble')
      const pixel = walk(
        b,
        132,
        size,
        size,
        { root: 0, item: 0, depth: 0 },
        reader.visit,
      )
      // A walk that ends at EOF found no Pixel Data; one cut short by EOF
      // (NeedMore with the whole file read, below) is a truncated file.
      if (pixel >= size)
        throw new Skip('not-tiled', 'no Pixel Data (e.g. a DICOMDIR)')
      if (pixel + 20 > b.length) throw new NeedMore() // Pixel Data and the BOT item header
      refuseSyntax(b, top)
      return { b, pixel, top, attributes: reader.attributes() }
    } catch (err) {
      refuseSyntax(b, top)
      if (!(err instanceof NeedMore)) throw err
      if (want >= size)
        throw new Skip('malformed', 'the file ends inside an element')
      if (want >= MAX_HEADER)
        throw new Skip('malformed', `header over ${MAX_HEADER >> 20} MiB`)
      want = Math.min(size, MAX_HEADER, want * 4)
    }
  }
}

/** Copy the visited element into `map`, reusing the copy a repeated tag made. */
function keep(map: Map<number, Element>, e: Element): void {
  const kept = map.get(e.tag)
  if (kept) Object.assign(kept, e)
  else map.set(e.tag, { ...e })
}

/**
 * Collects the header's attributes, in the form both readers share, as walk
 * visits them: only what the index reads is kept, never the elements.
 */
function attributeReader(b: Uint8Array) {
  const top = new Map<number, Element>()
  const view = new DataView(b.buffer, b.byteOffset, b.length)
  const a: WsiAttributes<SlideIndexIccProfile> = {
    text: {},
    number: {},
    spacing: [],
    pathIds: [],
    icc: [],
    perFrame: 0,
    column: [],
    row: [],
    z: [],
    path: [],
  }
  const colorSpaces: (string | undefined)[] = []
  const spacings: (string | undefined)[] = []
  // Decoded once at the end: the last of each wins, so a repeated one costs nothing.
  const shared = new Map<number, Element>()
  // Per-frame optical path identifiers, one string per distinct value.
  const frameIds = new Map<string, string>()
  const visit = (e: Element): void => {
    if (e.depth === 0) {
      keep(top, e)
    } else if (e.root === T.opticalPathSeq && e.depth === 1) {
      if (e.item >= MAX_PAIRS)
        throw new Skip('malformed', `over ${MAX_PAIRS} optical paths`)
      if (e.tag === T.opticalPathId) a.pathIds[e.item] = text(b, e)
      if (e.tag === T.iccProfile) {
        a.icc[e.item] ??= { offset: 0, length: 0 }
        const icc = a.icc[e.item] as SlideIndexIccProfile
        icc.offset = e.offset
        icc.length = e.length
      }
      if (e.tag === T.colorSpace) colorSpaces[e.item] = text(b, e)
    } else if (e.root === T.shared) {
      if (
        e.tag === T.spacing ||
        e.tag === T.opticalPathId ||
        e.tag === T.zOffset
      )
        keep(shared, e)
    } else if (e.root === T.perFrame) {
      const f = e.item
      a.perFrame = Math.max(a.perFrame, f + 1)
      if (e.tag === T.columnPosition) a.column[f] = numberOf(b, view, e)
      else if (e.tag === T.rowPosition) a.row[f] = numberOf(b, view, e)
      else if (e.tag === T.zOffset) a.z[f] = numberOf(b, view, e)
      else if (e.tag === T.opticalPathId) {
        const id = text(b, e)
        let known = frameIds.get(id)
        if (known === undefined) {
          // Each makes a pair at least.
          if (frameIds.size >= MAX_PAIRS)
            throw new Skip(
              'malformed',
              `over ${MAX_PAIRS} (optical path, focal plane) pairs`,
            )
          known = id
          frameIds.set(id, id)
        }
        a.path[f] = known
      } else if (e.tag === T.spacing && f === 0) spacings[1] = text(b, e)
    }
  }
  const attributes = (): WsiAttributes<SlideIndexIccProfile> => {
    const sharedOf = (tag: number) => {
      const e = shared.get(tag)
      return e && text(b, e)
    }
    spacings[0] = sharedOf(T.spacing)
    a.sharedPath = sharedOf(T.opticalPathId)
    const z = shared.get(T.zOffset)
    if (z) a.sharedZ = numberOf(b, view, z)
    a.icc.forEach((v, i) => {
      if (v && colorSpaces[i]) v.colorSpace = colorSpaces[i]
    })
    const topSpacing = top.get(T.spacing)
    if (topSpacing) spacings[2] = text(b, topSpacing)
    a.spacing = [0, 1, 2].map((i) => spacings[i]?.split('\\').map(Number))
    for (const tag of Object.keys(TEXT_KEYWORDS).map(Number)) {
      const e = top.get(tag)
      if (e) a.text[tag] = text(b, e)
    }
    for (const tag of Object.keys(NUMBER_KEYWORDS).map(Number)) {
      const e = top.get(tag)
      if (e) a.number[tag] = numberOf(b, view, e)
    }
    return a
  }
  return { top, visit, attributes }
}

/**
 * Place one instance's frames from its attributes: shared by local files and
 * DICOM JSON, so both index a slide alike. `maxFrames` bounds NumberOfFrames
 * before anything is sized by it.
 */
export function instanceGeometry<C>(
  a: WsiAttributes<C>,
  maxFrames: number,
): InstanceInfo<InstanceCore, C> {
  const { pathIds } = a
  const str = (tag: number): string => a.text[tag] ?? ''
  /** A whole number in [min, max] (`fallback` when absent); else the instance is malformed. */
  const int = (tag: number, fallback: number, min: number, max: number) => {
    const v = a.number[tag] ?? fallback
    if (!Number.isInteger(v) || v < min || v > max)
      throw new Skip('malformed', `${NUMBER_KEYWORDS[tag]} is ${v}`)
    return v
  }
  const tileWidth = int(T.columns, 0, 0, 0xffff)
  const tileHeight = int(T.rows, 0, 0, 0xffff)
  if (!tileWidth || !tileHeight) throw new Skip('not-tiled', 'no Rows/Columns')
  const frameCount = int(T.frames, 1, 1, maxFrames)
  const totalColumns = int(T.totalColumns, tileWidth, 1, 0xffffffff)
  const totalRows = int(T.totalRows, tileHeight, 1, 0xffffffff)
  const columns = Math.ceil(totalColumns / tileWidth)
  const rows = Math.ceil(totalRows / tileHeight)
  const grid = columns * rows
  if (grid > MAX_GRID)
    throw new Skip(
      'too-large',
      `${totalColumns} x ${totalRows} px in ${tileWidth} x ${tileHeight}-px tiles is ${grid} tiles, over the ${MAX_GRID} a level may hold`,
    )
  const focalPlaneCount = int(T.focalPlanes, 1, 1, 0xffff)
  const concatOffset = int(T.concatOffset, 0, 0, 0xffffffff)
  const organization = str(T.organization)
  const sparse = organization === 'TILED_SPARSE'
  const positioned = a.column.some((c) => c !== undefined)
  // Frames follow the implicit TILED_FULL order when the file says so, or as a
  // fallback when no frame states its position (3DHISTECH states no type).
  const implicit = organization === 'TILED_FULL' || (!sparse && !positioned)
  if (implicit) {
    // They enumerate tiles x planes x paths, so none lies past them; a huge
    // concatenation offset would otherwise derive a huge path index.
    const pathCount = int(T.opticalPaths, 1, 1, 0xffff)
    if (concatOffset + frameCount > grid * focalPlaneCount * pathCount)
      throw new Skip(
        'malformed',
        `frames past ${grid} tiles x ${focalPlaneCount} planes x ${pathCount} paths`,
      )
  }
  const info: InstanceInfo<InstanceCore, C> = {
    instance: {
      id: str(T.sop),
      transferSyntax: str(T.transferSyntax),
      photometric: str(T.photometric),
      bitsStored: int(T.bitsStored, 8, 1, 32),
    },
    study: str(T.study),
    series: str(T.series),
    frameOfReference: str(T.frameOfReference),
    container: str(T.container) || undefined,
    // Without ImageType, a stated matrix of more than one tile is a pyramid
    // level; a single-tile label, macro or thumbnail is not.
    volume: str(T.imageType)
      ? str(T.imageType).includes('VOLUME')
      : T.totalColumns in a.number && T.totalRows in a.number && grid > 1,
    totalColumns,
    totalRows,
    tileWidth,
    tileHeight,
    columns,
    rows,
    frameCount,
    sparse,
    concatNumber: int(T.concatNumber, 0, 0, 0xffff),
    pathIds,
    icc: a.icc,
    column: new Int32Array(frameCount),
    row: new Int32Array(frameCount),
    path: new Uint32Array(frameCount),
    z: new Float64Array(frameCount),
    zStated: false,
    planes: [],
    offset: new Float64Array(frameCount),
    length: new Uint32Array(frameCount),
  }
  info.pixelSpacingMM = spacingOf(a, totalColumns, totalRows)
  const { column, row, path, z } = info
  const { perFrame } = a
  if (sparse && !perFrame)
    throw new Skip('malformed', 'TILED_SPARSE without per-frame positions')
  if (perFrame && perFrame !== frameCount)
    throw new Skip(
      'malformed',
      `${perFrame} per-frame items for ${frameCount} frames`,
    )
  if (!implicit) {
    // Placed only by the per-frame positions below; a frame without one stays -1.
    column.fill(-1)
    row.fill(-1)
  } else {
    // TILED_FULL orders frames by column, row, focal plane, then optical path.
    // Per-frame items may hold only other metadata; positions they do give win.
    for (let f = 0; f < frameCount; f++) {
      const g = concatOffset + f
      const t = g % grid
      column[f] = t % columns
      row[f] = Math.floor(t / columns)
      z[f] = Math.floor(g / grid) % focalPlaneCount
      path[f] = Math.floor(g / (grid * focalPlaneCount))
    }
  }
  // An identifier missing from OpticalPathSequence is its own path, not path 0.
  // MAX_PAIRS below bounds how many paths a file can name.
  const pathIndex = new Map<string, number>()
  pathIds.forEach((id, i) => {
    if (!pathIndex.has(id)) pathIndex.set(id, i)
  })
  const pathOf = (id: string): number => {
    const known = pathIndex.get(id)
    if (known !== undefined) return known
    // Past every sequence item, so an unnamed last item's ICC is not inherited.
    pathIds.length = Math.max(pathIds.length, a.icc.length)
    pathIndex.set(id, pathIds.length)
    return pathIds.push(id) - 1
  }
  // A shared OpticalPathIdentifier names every frame's path.
  if (a.sharedPath !== undefined) path.fill(pathOf(a.sharedPath))
  // A position must name a tile's top-left pixel (1-based); anything else is
  // -1, an error buildLevel counts, never a tile placed at 0.
  const place = (pos: number, size: number): number =>
    Number.isInteger(pos) && pos >= 1 && (pos - 1) % size === 0
      ? (pos - 1) / size
      : -1
  let zCount = 0
  for (let f = 0; f < perFrame; f++) {
    const c = a.column[f]
    const r = a.row[f]
    const zf = a.z[f]
    const p = a.path[f]
    if (c !== undefined) column[f] = place(c, tileWidth)
    if (r !== undefined) row[f] = place(r, tileHeight)
    if (zf !== undefined) {
      z[f] = zf
      zCount++
    }
    if (p !== undefined) path[f] = pathOf(p)
  }
  // Otherwise µm and implicit plane indices would mix.
  if (zCount && zCount !== frameCount)
    throw new Skip('malformed', `ZOffset on ${zCount} of ${frameCount} frames`)
  // One shared ZOffset cannot place several implicit planes; they keep their indices.
  const { sharedZ } = a
  const useSharedZ =
    !zCount && sharedZ !== undefined && (!implicit || focalPlaneCount === 1)
  if (useSharedZ) z.fill(sharedZ)
  info.zStated = zCount > 0 || useSharedZ
  // Each (optical path, focal plane) becomes a slide with its own grid-sized
  // tile map, so a small file naming thousands of planes must not reach groupSlides.
  const { planes } = info
  let pairs = 0
  for (let f = 0; f < frameCount; f++) {
    // To the nanometre, so 0.5 and 0.50001 µm are one plane; implicit indices are whole.
    const zf = Math.round((z[f] as number) * 1000) / 1000
    if (!Number.isFinite(zf))
      throw new Skip('malformed', `frame ${f + 1} has no finite focal plane`)
    z[f] = zf
    const p = path[f] as number
    planes[p] ??= new Set()
    const seen = planes[p] as Set<number>
    if (seen.has(zf)) continue
    seen.add(zf)
    if (++pairs > MAX_PAIRS)
      throw new Skip(
        'malformed',
        `over ${MAX_PAIRS} (optical path, focal plane) pairs`,
      )
  }
  return info
}

async function indexInstance(file: File): Promise<InstanceInfo> {
  const size = file.size
  const readAt: ReadAt = async (offset, length) =>
    new Uint8Array(await file.slice(offset, offset + length).arrayBuffer())
  const { b, pixel, top, attributes } = await readHeader(readAt, size)
  // Each frame needs at least its 8-byte item header after Pixel Data.
  const g = instanceGeometry(attributes, Math.floor((size - pixel) / 8))
  const instance = {
    ...g.instance,
    file: fileKey(file),
    size,
    version: String(file.lastModified),
  }
  const info = { ...g, instance }
  await frameSpans(info, b, pixel, top, readAt)
  return info
}

const positive = (v: number | undefined): v is number =>
  Number.isFinite(v) && (v as number) > 0

/**
 * Level pixel spacing in mm, [column, row]: the first valid PixelSpacing
 * (row, column) candidate, else ImagedVolumeWidth/Height (mm) over the total
 * pixel matrix. WSI files often carry a [1,1] PixelSpacing placeholder, so it
 * yields to the volume size (as in niivue's scripts/fetch-dicom-wsi.ts), but
 * is kept when there is no volume size to replace it.
 */
function spacingOf<C>(
  a: WsiAttributes<C>,
  totalColumns: number,
  totalRows: number,
): [number, number] | undefined {
  let unit: [number, number] | undefined
  for (const s of a.spacing) {
    if (!s || !positive(s[0]) || !positive(s[1])) continue
    if (s[0] !== 1 || s[1] !== 1) return [s[1], s[0]]
    unit = [1, 1]
  }
  const volumeWidth = a.number[T.volumeWidth]
  const volumeHeight = a.number[T.volumeHeight]
  return positive(volumeWidth) && positive(volumeHeight)
    ? [volumeWidth / totalColumns, volumeHeight / totalRows]
    : unit
}

/** Fill `info.offset`/`info.length` from the encapsulated pixel data. */
async function frameSpans(
  info: InstanceInfo,
  b: Uint8Array,
  pixel: number,
  top: Map<number, Element>,
  readAt: ReadAt,
): Promise<void> {
  const { frameCount, offset, length } = info
  const { size } = info.instance
  const vr = String.fromCharCode(b[pixel + 4] as number, b[pixel + 5] as number)
  if (vr !== 'OB' && vr !== 'OW')
    throw new Skip('malformed', `Pixel Data has VR ${vr}`)
  if (u32(b, pixel + 8) !== UNDEFINED_LENGTH)
    throw new Skip('uncompressed', 'native (uncompressed) pixel data')
  if (tagOf(u16(b, pixel + 12), u16(b, pixel + 14)) !== T.item)
    throw new Skip('malformed', 'no Basic Offset Table item')
  const botLength = u32(b, pixel + 16)
  const first = pixel + 20 + botLength // the first fragment's item header
  if (first > size)
    throw new Skip('malformed', 'the Basic Offset Table runs past the file')
  const itemHeader = async (
    p: number,
  ): Promise<{ tag: number; length: number }> => {
    const h = await readAt(p, 8)
    return { tag: tagOf(u16(h, 0), u16(h, 2)), length: u32(h, 4) }
  }
  const eot = top.get(T.eot)
  const eotLengths = top.get(T.eotLengths)
  if (
    eot &&
    eotLengths &&
    eot.length >= 8 * frameCount &&
    eotLengths.length >= 8 * frameCount
  ) {
    // Extended Offset Table: one fragment per frame, 64-bit offsets from the first item.
    const o = new DataView(b.buffer, b.byteOffset + eot.offset, eot.length)
    const l = new DataView(
      b.buffer,
      b.byteOffset + eotLengths.offset,
      eotLengths.length,
    )
    let valid = true
    for (let f = 0; f < frameCount && valid; f++) {
      offset[f] = first + Number(o.getBigUint64(8 * f, true)) + 8
      const n = Number(l.getBigUint64(8 * f, true))
      valid = n <= 0xffffffff && (offset[f] as number) + n <= size
      length[f] = n
    }
    if (valid) return
  } else if (botLength === 4 * frameCount && botLength > 0) {
    // Basic Offset Table: each span runs to the next frame's item header; the
    // last runs to the sequence delimiter. DicomWsiSource verifies the item tag.
    const bot = await readAt(pixel + 20, botLength)
    for (let f = 0; f < frameCount; f++) offset[f] = first + u32(bot, 4 * f) + 8
    // PS3.5 A.4: the first entry is 0.
    let valid = u32(bot, 0) === 0 && (offset[frameCount - 1] as number) <= size
    for (let f = 0; f + 1 < frameCount && valid; f++) {
      const n = (offset[f + 1] as number) - 8 - (offset[f] as number)
      valid = n >= 0
      length[f] = n
    }
    if (valid) {
      let p = (offset[frameCount - 1] as number) - 8
      while (p + 8 <= size) {
        const h = await itemHeader(p)
        if (h.tag !== T.item || p + 8 + h.length > size) break
        p += 8 + h.length
      }
      // A last entry that is not at an item header fails here: walk instead.
      if (p > (offset[frameCount - 1] as number) - 8) {
        length[frameCount - 1] = p - (offset[frameCount - 1] as number)
        return
      }
    }
  }
  // No table, or a table that is not strictly increasing within the file: walk
  // the items. A frame starts at a fragment that starts a codestream (several
  // fragments may make one frame; never assume item == frame). After a small
  // fragment, the next headers are read as one 64 KiB block; after a large one,
  // just the 12 bytes, so a walk never reads the payloads.
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
      (h[8] === 0xff && h[9] === 0x4f && h[10] === 0xff && h[11] === 0x51) || // J2K start-of-codestream + image-size markers
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
 * selection). Files that are not tiled, compressed, explicit-VR DICOM, or that
 * fail to parse, are listed in `skipped`; they never cost the other files their
 * slides. Only VOLUME instances make levels; each optical path and focal plane
 * is its own slide.
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
      skipped.push(skipOf(fileKey(file), err))
    }
  }
  return {
    version: 1,
    producer: 'nv-ext-tile/indexDicomWsi',
    slides: groupSlides(infos, skipped, (i) => i.file),
    skipped,
  }
}

/** A skipped instance, named `file`: why `err` left it out. */
export const skipOf = (file: string, err: unknown): SlideIndexSkipped => ({
  file,
  reason: err instanceof Skip ? err.reason : 'malformed',
  message: err instanceof Error ? err.message : String(err),
})

interface Member<I = unknown, C = unknown> {
  info: InstanceInfo<I, C>
  pathIndex: number
  /** The file's frames on this slide's path and plane. */
  frames: number[]
}

type Placed = InstanceInfo<unknown, unknown>

// TILED_FULL can derive a path index past the sequence's items.
const pathName = (info: Placed, pathIndex: number): string =>
  info.pathIds[pathIndex] ?? String(pathIndex)

/** A slide's identity short of its focal plane. */
const slideBase = (info: Placed, pathIndex: number): string =>
  [
    info.study,
    info.series,
    info.frameOfReference,
    info.container ?? '',
    pathName(info, pathIndex),
  ].join('|')

const matrix = (info: Placed): string =>
  `${info.totalColumns}x${info.totalRows}`

/**
 * Frames of reference of one study, series and container join when no level
 * size is in both and their finest levels span the same extent: some converters
 * give each pyramid level its own FrameOfReferenceUID (OHIF's test slide does),
 * while a rescan repeats the sizes and another scan spans another extent. The
 * joined instances take their finest level's frame of reference, before
 * rankStatedPlanes, so planes are ranked across the joined slide.
 */
function joinFramesOfReference(infos: Placed[]): void {
  const groups = new Map<string, Placed[]>()
  for (const info of infos) {
    if (!info.volume) continue
    const { study, series, frameOfReference, container } = info
    const key = [study, series, frameOfReference, container ?? ''].join('|')
    const group = groups.get(key)
    if (group) group.push(info)
    else groups.set(key, [info])
  }
  const area = (i: Placed) => i.totalColumns * i.totalRows
  // Ties go to the lower frame of reference, so input order never decides.
  const before = (a: Placed, b: Placed) =>
    area(b) - area(a) || (a.frameOfReference < b.frameOfReference ? -1 : 1)
  const finest = (g: Placed[]) => g.reduce((a, b) => (before(b, a) < 0 ? b : a))
  // Relative to the larger extent, so the result does not depend on order.
  const differs = (a: number[], b: number[]) =>
    a.some((v, k) => {
      const w = b[k] as number
      return Math.abs(v - w) > 0.05 * Math.max(v, w)
    })
  /**
   * The extent of a group's finest instances (all of them when tied, so input
   * order never picks one); undefined when they disagree, which joins nothing.
   * NaN (no spacing, or spacingOf's 1\1 placeholder, both axes) never differs,
   * so it joins.
   */
  const extent = (g: Placed[]): number[] | undefined => {
    const top = area(finest(g))
    const stated = g
      .filter((i) => area(i) === top)
      .flatMap(({ totalColumns, totalRows, pixelSpacingMM: mm }) =>
        mm && !(mm[0] === 1 && mm[1] === 1)
          ? [[totalColumns * mm[0], totalRows * mm[1]]]
          : [],
      )
    if (stated.some((a) => stated.some((b) => differs(a, b)))) return undefined
    return stated.length
      ? [0, 1].map((k) => Math.min(...stated.map((e) => e[k] as number)))
      : [Number.NaN, Number.NaN]
  }
  // Finest first, so each slide is anchored by its full-size level; a group
  // that fits more than one slide (a coarse level beside two rescans) has no
  // single owner and stays apart.
  const sorted = [...groups.values()].sort((a, b) =>
    before(finest(a), finest(b)),
  )
  const joined = new Map<string, Placed[][]>()
  for (const g of sorted) {
    const { study, series, container } = g[0] as Placed
    const key = [study, series, container ?? ''].join('|')
    const list = joined.get(key) ?? []
    const mine = new Set(g.map(matrix))
    const at = extent(g)
    const fits = list.filter((e) => {
      const theirs = extent(e)
      return (
        at !== undefined &&
        theirs !== undefined &&
        !e.some((i) => mine.has(matrix(i))) &&
        !differs(at, theirs)
      )
    })
    if (fits.length === 1) fits[0]?.push(...g)
    else list.push(g)
    joined.set(key, list)
  }
  for (const list of joined.values())
    for (const g of list) {
      const { frameOfReference } = finest(g)
      for (const info of g) info.frameOfReference = frameOfReference
    }
}

/** Stated ZOffsets (µm) become ranks across all of a slide's levels, so a lower
 * level holding only some planes joins the right ones; implicit TILED_FULL
 * indices already are ranks. */
function rankStatedPlanes(infos: Placed[]): void {
  const stated = infos.filter((info) => info.volume && info.zStated)
  const all = new Map<string, Set<number>>()
  for (const info of stated)
    info.planes.forEach((set, p) => {
      const base = slideBase(info, p)
      const into = all.get(base) ?? new Set<number>()
      for (const v of set) into.add(v)
      all.set(base, into)
    })
  const ranks = new Map(
    [...all].map(([base, set]) => [
      base,
      new Map([...set].sort((a, c) => a - c).map((v, k) => [v, k])),
    ]),
  )
  for (const info of stated) {
    const byPath = info.planes.map(
      (_, p) => ranks.get(slideBase(info, p)) as Map<number, number>,
    )
    const { z, path } = info
    for (let f = 0; f < info.frameCount; f++) {
      const rank = byPath[path[f] as number] as Map<number, number>
      z[f] = rank.get(z[f] as number) as number
    }
  }
}

/** A slide as groupSlides makes it, with the reader's instances and ICC profile. */
type GroupedSlide<I, C> = Omit<SlideIndexSlide, 'instances' | 'iccProfile'> & {
  instances: I[]
  iccProfile?: C
}

/**
 * Contract 2: a slide is study + series + frame of reference + container +
 * optical path + focal plane, after joinFramesOfReference.
 */
export function groupSlides<I, C>(
  infos: InstanceInfo<I, C>[],
  skipped: SlideIndexSkipped[],
  /** The name `skipped` gives an instance. */
  nameOf: (instance: I) => string,
): GroupedSlide<I, C>[] {
  joinFramesOfReference(infos)
  rankStatedPlanes(infos)
  type Entry = { slide: GroupedSlide<I, C>; own: Member<I, C>[] }
  const slides = new Map<string, Entry>()
  for (const info of infos) {
    if (!info.volume) continue
    // One pass buckets the frames, so each slide walks only its own.
    const buckets: Map<number, number[]>[] = []
    for (let f = 0; f < info.frameCount; f++) {
      const p = info.path[f] as number
      buckets[p] ??= new Map()
      const byPlane = buckets[p] as Map<number, number[]>
      const z = info.z[f] as number
      const list = byPlane.get(z)
      if (list) list.push(f)
      else byPlane.set(z, [f])
    }
    buckets.forEach((byPlane, pathIndex) => {
      const opticalPath = pathName(info, pathIndex)
      const base = slideBase(info, pathIndex)
      for (const [plane, frames] of byPlane) {
        const key = `${base}|${plane}`
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
        entry.own.push({ info, pathIndex, frames })
      }
    })
  }
  const reported = new Set<string>()
  return [...slides.values()].map(({ slide, own: members }) => {
    // Finest first; a concatenation's parts in order.
    members.sort(
      (a, b) =>
        b.info.totalColumns * b.info.totalRows -
          a.info.totalColumns * a.info.totalRows ||
        a.info.concatNumber - b.info.concatNumber,
    )
    // Opening a slide builds a map per level; a real pyramid totals about 4/3 of
    // level 0, so near-equal levels past this are dropped, not built.
    const fits = new Map<string, boolean>()
    let slots = 0
    const own = members.filter(({ info }) => {
      const key = `${info.totalColumns}x${info.totalRows}`
      let ok = fits.get(key)
      if (ok === undefined) {
        slots += info.columns * info.rows
        ok = slots <= MAX_SLIDE_TILES
        fits.set(key, ok)
      }
      const name = nameOf(info.instance)
      if (!ok && !reported.has(name)) {
        reported.add(name)
        skipped.push({
          file: name,
          reason: 'malformed',
          message: `level ${key} takes its slide past ${MAX_SLIDE_TILES} tiles`,
        })
      }
      return ok
    })
    slide.instances = own.map((m) => m.info.instance)
    const byMatrix = new Map<string, number[]>()
    own.forEach(({ info }, k) => {
      const key = `${info.totalColumns}x${info.totalRows}`
      const list = byMatrix.get(key)
      if (list) list.push(k)
      else byMatrix.set(key, [k])
    })
    for (const ks of byMatrix.values()) slide.levels.push(buildLevel(ks, own))
    const l0 = own[0] as Member<I, C>
    slide.pixelSpacingMM = l0.info.pixelSpacingMM
    slide.iccProfile = l0.info.icc[l0.pathIndex]
    return slide
  })
}

function buildLevel(ks: number[], own: Member[]): SlideIndexLevel {
  const i0 = (own[ks[0] as number] as Member).info
  const { columns, rows } = i0
  const total = ks.reduce((n, k) => n + (own[k] as Member).frames.length, 0)
  const frames: SlideIndexFrames = {
    instance: new Uint32Array(total),
    frame: new Uint32Array(total),
    offset: new Float64Array(total),
    length: new Uint32Array(total),
    tile: new Int32Array(total),
  }
  let slot = 0
  for (const k of ks) {
    const m = own[k] as Member
    const { info } = m
    for (const f of m.frames) {
      const x = info.column[f] as number
      const y = info.row[f] as number
      frames.instance[slot] = k
      frames.frame[slot] = f + 1
      frames.offset[slot] = info.offset[f] as number
      frames.length[slot] = info.length[f] as number
      frames.tile[slot] =
        x < 0 || y < 0 || x >= columns || y >= rows ? -1 : y * columns + x
      slot++
    }
  }
  // Counted by sorting the frames' tiles, so indexing never allocates a grid-sized map.
  const sorted = frames.tile.slice().sort()
  // -1 (invalid) sorts first, so one compare skips it and repeats.
  let placed = 0
  let prev = -1
  for (const t of sorted)
    if (t > prev) {
      placed++
      prev = t
    }
  const holes = columns * rows - placed
  return {
    width: i0.totalColumns,
    height: i0.totalRows,
    tileWidth: i0.tileWidth,
    tileHeight: i0.tileHeight,
    columns,
    rows,
    instances: ks,
    frames,
    duplicates: total - placed,
    holes,
    // Frames past one per tile (duplicates, off-grid) are not a dense grid either.
    sparse:
      holes > 0 ||
      total > placed ||
      ks.some((k) => (own[k] as Member).info.sparse),
  }
}

/**
 * A level's `columns * rows` row-major tile map: each tile's frame slot, or -1
 * for a hole. Grid-sized, so it is built when a slide is opened, not indexed.
 * An invalid position or a second frame for a tile is an error; the first wins.
 */
export function tileMap(
  level: Pick<SlideIndexLevel, 'columns' | 'rows'> & {
    frames: Pick<SlideIndexFrames, 'tile'>
  },
): Int32Array {
  const map = new Int32Array(level.columns * level.rows).fill(-1)
  const { tile } = level.frames
  // Backwards, so the first frame for a tile is written last and wins.
  for (let slot = tile.length - 1; slot >= 0; slot--) {
    const t = tile[slot] as number
    if (t >= 0) map[t] = slot
  }
  return map
}
