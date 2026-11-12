import { describe, expect, test } from 'bun:test'
import {
  indexDicomWsi,
  type SlideIndexLevel,
  type SlideIndexSlide,
  tileMap,
} from './dicomIndex'
import { DicomWsiSource } from './dicomWsiSource'

// Hostile and malformed inputs, built byte by byte here (explicit VR little
// endian), so each test states exactly what is wrong with its file.

const LONG = new Set('OB OD OF OL OV OW SQ SV UC UN UR UT UV'.split(' '))
const UNDEF = 0xffffffff
const cat = (...parts: Uint8Array[]): Uint8Array<ArrayBuffer> => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0))
  let o = 0
  for (const p of parts) {
    out.set(p, o)
    o += p.length
  }
  return out
}
const le = (n: number, bytes: number): Uint8Array => {
  const b = new Uint8Array(bytes)
  for (let i = 0; i < bytes; i++) b[i] = Math.floor(n / 2 ** (8 * i)) & 0xff
  return b
}
const tag = (g: number, e: number) => cat(le(g, 2), le(e, 2))
/** An element; `length` overrides the value's length (to lie about it). */
function el(
  g: number,
  e: number,
  vr: string,
  value: Uint8Array,
  length = value.length,
): Uint8Array {
  const v = new TextEncoder().encode(vr)
  return LONG.has(vr)
    ? cat(tag(g, e), v, new Uint8Array(2), le(length, 4), value)
    : cat(tag(g, e), v, le(length, 2), value)
}
const str = (s: string, pad = ' ') =>
  new TextEncoder().encode(s.length % 2 ? s + pad : s)
const item = (...content: Uint8Array[]) =>
  cat(
    tag(0xfffe, 0xe000),
    le(UNDEF, 4),
    ...content,
    tag(0xfffe, 0xe00d),
    le(0, 4),
  )
const sq = (g: number, e: number, items: Uint8Array[]) =>
  cat(
    el(g, e, 'SQ', new Uint8Array(0), UNDEF),
    ...items,
    tag(0xfffe, 0xe0dd),
    le(0, 4),
  )
/** A frame's payload: FF D8 <label> FF D9, so a tile's bytes name its frame. */
const payload = (k: number) => new Uint8Array([0xff, 0xd8, k, k, 0xff, 0xd9])
const fragment = (bytes: Uint8Array) =>
  cat(tag(0xfffe, 0xe000), le(bytes.length, 4), bytes)
function pixelData(frames: Uint8Array[], bot?: number[]): Uint8Array {
  const table = bot ? cat(...bot.map((o) => le(o, 4))) : new Uint8Array(0)
  return cat(
    el(0x7fe0, 0x0010, 'OB', new Uint8Array(0), UNDEF),
    tag(0xfffe, 0xe000),
    le(table.length, 4),
    table,
    ...frames.map(fragment),
    tag(0xfffe, 0xe0dd),
    le(0, 4),
  )
}
/** A 2 x 2-tile VOLUME level (16-px tiles), overridable element by element. */
function dicom(
  over: Record<string, Uint8Array | null> = {},
  pixel: Uint8Array = pixelData([0, 1, 2, 3].map(payload)),
): File {
  const els: Record<string, Uint8Array | null> = {
    imageType: el(0x0008, 0x0008, 'CS', str('ORIGINAL\\PRIMARY\\VOLUME\\NONE')),
    sop: el(0x0008, 0x0018, 'UI', str('1.2.9.1', '\0')),
    study: el(0x0020, 0x000d, 'UI', str('1.2.9.2', '\0')),
    series: el(0x0020, 0x000e, 'UI', str('1.2.9.3', '\0')),
    org: el(0x0020, 0x9311, 'CS', str('TILED_FULL')),
    photometric: el(0x0028, 0x0004, 'CS', str('YBR_FULL_422')),
    frames: el(0x0028, 0x0008, 'IS', str('4')),
    rows: el(0x0028, 0x0010, 'US', le(16, 2)),
    columns: el(0x0028, 0x0011, 'US', le(16, 2)),
    totalColumns: el(0x0048, 0x0006, 'UL', le(32, 4)),
    totalRows: el(0x0048, 0x0007, 'UL', le(32, 4)),
    ...over,
  }
  const meta = el(0x0002, 0x0010, 'UI', str('1.2.840.10008.1.2.4.50', '\0'))
  const body = Object.values(els).filter((e): e is Uint8Array => e !== null)
  const bytes = cat(new Uint8Array(128), str('DICM'), meta, ...body, pixel)
  return new File(
    [bytes.buffer as ArrayBuffer],
    `${Object.keys(over).join('-') || 'good'}.dcm`,
    {
      lastModified: 1,
    },
  )
}

/** Plane Position (Slide) Sequence holding these ZOffsets (µm). */
const zSeq = (...zs: string[]) =>
  sq(
    0x0048,
    0x021a,
    zs.map((z) => item(el(0x0040, 0x074a, 'DS', str(z)))),
  )
const planesOf = (idx: Awaited<ReturnType<typeof indexDicomWsi>>) =>
  idx.slides.map((s) => [
    s.focalPlane,
    s.levels.map((l) => [l.width, l.frames.offset.length, l.duplicates]),
  ])

const reasons = async (file: File) =>
  (await indexDicomWsi([file])).skipped.map((s) => s.reason)

/** Each present tile's payload label, row-major, -1 for a hole. */
async function tileLabels(slide: SlideIndexSlide, files: File[]) {
  const source = new DicomWsiSource(slide, files)
  const level = source.manifest.levels[0]
  if (!level) throw new Error('no level')
  return Promise.all(
    level.tiles.map(async (t) =>
      t ? ((await source.fetchTileBytes(level, t, ''))[2] as number) : -1,
    ),
  )
}

describe('indexDicomWsi on hostile input', () => {
  test('a well-formed file indexes (the builder is sound)', async () => {
    const good = dicom()
    const idx = await indexDicomWsi([good])
    expect(idx.skipped).toEqual([])
    expect(await tileLabels(idx.slides[0] as SlideIndexSlide, [good])).toEqual([
      0, 1, 2, 3,
    ])
  })

  test('one bad file never costs the others their slides', async () => {
    const good = dicom()
    const bad = dicom({ rows: el(0x0028, 0x0010, 'US', new Uint8Array(0)) }) // an empty US
    const idx = await indexDicomWsi([bad, good])
    expect(idx.slides).toHaveLength(1)
    expect(idx.skipped.map((s) => [s.file, s.reason])).toEqual([
      ['rows.dcm', 'malformed'],
    ])
  })

  test('deeply nested sequences are refused quickly, in bounded memory', async () => {
    // sq(item(sq(item(...)))) built as all openers then all closers; nesting
    // by repeated cat() is quadratic and times out on CI.
    const open = cat(
      el(0x0009, 0x0010, 'SQ', new Uint8Array(0), UNDEF),
      tag(0xfffe, 0xe000),
      le(UNDEF, 4),
    )
    const close = cat(
      tag(0xfffe, 0xe00d),
      le(0, 4),
      tag(0xfffe, 0xe0dd),
      le(0, 4),
    )
    const depth = 20000
    const nest = cat(...Array(depth).fill(open), ...Array(depth).fill(close))
    const file = dicom({ nest })
    expect(file.size).toBeGreaterThan(700_000)
    const t0 = performance.now()
    expect(await reasons(file)).toEqual(['malformed'])
    expect(performance.now() - t0).toBeLessThan(500)
  })

  test('a frame count or grid that the file cannot hold is malformed', async () => {
    for (const frames of ['1000000000', '-1', '1.5', 'abc'])
      expect(
        await reasons(dicom({ frames: el(0x0028, 0x0008, 'IS', str(frames)) })),
      ).toEqual(['malformed'])
    const giant = dicom({
      rows: el(0x0028, 0x0010, 'US', le(1, 2)),
      columns: el(0x0028, 0x0011, 'US', le(1, 2)),
      totalColumns: el(0x0048, 0x0006, 'UL', le(0xffffffff, 4)),
      totalRows: el(0x0048, 0x0007, 'UL', le(0xffffffff, 4)),
    })
    expect(await reasons(giant)).toEqual(['too-large'])
  })

  test('a level past the tile cap says it is too large, with its sizes', async () => {
    // About 1 TB of RGB at 256-px tiles: 2344 x 2344 tiles, over 2^22.
    const idx = await indexDicomWsi([
      dicom({
        rows: el(0x0028, 0x0010, 'US', le(256, 2)),
        columns: el(0x0028, 0x0011, 'US', le(256, 2)),
        totalColumns: el(0x0048, 0x0006, 'UL', le(600000, 4)),
        totalRows: el(0x0048, 0x0007, 'UL', le(600000, 4)),
      }),
    ])
    expect(idx.skipped.map((k) => [k.reason, k.message])).toEqual([
      [
        'too-large',
        '600000 x 600000 px in 256 x 256-px tiles is 5494336 tiles, over the 4194304 a level may hold',
      ],
    ])
  })

  test('an undefined-length UN element is skipped as an implicit VR sequence', async () => {
    // PS3.5 6.2.2: its items are implicit VR little endian, so tag + 4-byte
    // length; one value holds the bytes of a sequence delimiter.
    const implicit = (
      g: number,
      e: number,
      value: Uint8Array,
      length = value.length,
    ) => cat(tag(g, e), le(length, 4), value)
    const un = cat(
      el(0x0011, 0x1010, 'UN', new Uint8Array(0), UNDEF),
      item(
        implicit(0x0011, 0x1011, new Uint8Array([0xfe, 0xff, 0xdd, 0xe0])),
        implicit(0x0011, 0x1012, new Uint8Array(0), UNDEF),
        fragment(new Uint8Array([1, 2, 3, 4])),
        item(implicit(0x0011, 0x1013, str('ab'))),
        tag(0xfffe, 0xe0dd),
        le(0, 4),
      ),
      fragment(str('xy')),
      tag(0xfffe, 0xe0dd),
      le(0, 4),
    )
    // Before Rows/Columns, so misreading it would lose them.
    const f = dicom({
      photometric: cat(el(0x0028, 0x0004, 'CS', str('YBR_FULL_422')), un),
    })
    const idx = await indexDicomWsi([f])
    expect(idx.skipped).toEqual([])
    expect(await tileLabels(idx.slides[0] as SlideIndexSlide, [f])).toEqual([
      0, 1, 2, 3,
    ])
  })

  test('a UN sequence cut off by the end of the file is malformed', async () => {
    const head = cat(
      new Uint8Array(128),
      str('DICM'),
      el(0x0011, 0x1010, 'UN', new Uint8Array(0), UNDEF),
    )
    // Ends inside the sequence, and inside an undefined-length item.
    expect(await reasons(new File([head], 'h.dcm'))).toEqual(['malformed'])
    const inItem = cat(head, tag(0xfffe, 0xe000), le(UNDEF, 4))
    expect(await reasons(new File([inItem], 'h.dcm'))).toEqual(['malformed'])
  })

  test('an SQ cut off by the end of the file is malformed', async () => {
    const pre = cat(new Uint8Array(128), str('DICM'))
    const open = cat(pre, el(0x0011, 0x1010, 'SQ', new Uint8Array(0), UNDEF))
    const inItem = cat(open, tag(0xfffe, 0xe000), le(UNDEF, 4))
    const tooLong = cat(pre, el(0x0011, 0x1010, 'SQ', new Uint8Array(0), 1000))
    // Cut inside an item tag, an item length, a delimiter, a nested element.
    const cuts = [
      [0xfe, 0xff],
      [0xfe, 0xff, 0x00, 0xe0],
      [0xfe, 0xff, 0xdd, 0xe0],
    ]
      .map((bytes) => cat(open, new Uint8Array(bytes)))
      .concat(cat(inItem, new Uint8Array([0x11, 0x00])))
    for (const head of [open, inItem, tooLong, ...cuts])
      expect(await reasons(new File([head], 'h.dcm'))).toEqual(['malformed'])
    // A file that ends between elements has no Pixel Data: not truncated.
    const whole = cat(pre, el(0x0011, 0x1010, 'SQ', new Uint8Array(0), 0))
    expect(await reasons(new File([whole], 'h.dcm'))).toEqual(['not-tiled'])
  })

  test('tiny native Pixel Data at the end of the file is not truncated', async () => {
    const pre = cat(new Uint8Array(128), str('DICM'))
    const tiny = cat(pre, el(0x7fe0, 0x0010, 'OB', new Uint8Array(4)))
    expect(await reasons(new File([tiny], 'h.dcm'))).toEqual(['not-tiled'])
    // Encapsulated Pixel Data cut before its offset-table item is truncated.
    const cut = cat(pre, el(0x7fe0, 0x0010, 'OB', new Uint8Array(0), UNDEF))
    expect(await reasons(new File([cut], 'h.dcm'))).toEqual(['malformed'])
  })

  test('a text value over 1 KiB is malformed, never decoded', async () => {
    const f = dicom({
      study: el(0x0020, 0x000d, 'UT', new Uint8Array(16 << 20).fill(0x31)),
    })
    expect((await indexDicomWsi([f])).skipped[0]?.message).toBe(
      '16777216-byte UT at byte 226',
    )
  })

  test('more than 4096 OpticalPathSequence items are malformed', async () => {
    const id = el(0x0048, 0x0106, 'SH', str('1'))
    const f = dicom({
      opticalPathSeq: sq(0x0048, 0x0105, Array(4097).fill(item(id))),
    })
    expect((await indexDicomWsi([f])).skipped[0]?.message).toBe(
      'over 4096 optical paths',
    )
  })

  test('a header of millions of elements indexes in bounded memory', () => {
    // In a fresh process, as peak RSS only grows. 16 MiB of header: junk
    // top-level elements, then one per-frame item repeating a ZOffset. Each
    // element took about 200 bytes of heap before (940 MB here, now 85).
    const script = `
      const { indexDicomWsi } = await import(${JSON.stringify(`${import.meta.dir}/dicomIndex.ts`)})
      const half = 8 << 20
      const b = new Uint8Array(2 * half + 1024)
      const v = new DataView(b.buffer)
      b.set([68, 73, 67, 77], 128)
      let o = 132
      const put = (bytes) => { b.set(bytes, o); o += bytes.length }
      const junk = [0x09, 0, 0, 0x10, 76, 79, 0, 0] // (0009,1000) LO, empty
      while (o < half) put(junk)
      put([0, 0x52, 0x30, 0x92, 83, 81, 0, 0, 255, 255, 255, 255, 254, 255, 0, 224, 255, 255, 255, 255])
      const z = [0x40, 0, 0x4a, 0x07, 68, 83, 2, 0, 49, 32] // (0040,074A) DS '1'
      while (o < 2 * half) put(z)
      put([254, 255, 13, 224, 0, 0, 0, 0, 254, 255, 221, 224, 0, 0, 0, 0])
      put([0xe0, 0x7f, 0x10, 0, 79, 66, 0, 0, 255, 255, 255, 255, 254, 255, 0, 224, 0, 0, 0, 0, 254, 255, 221, 224, 0, 0, 0, 0])
      const file = new File([b.subarray(0, o)], 'h.dcm')
      const r0 = process.resourceUsage().maxRSS
      const idx = await indexDicomWsi([file])
      // ru_maxrss is bytes on macOS, KiB on Linux: scale by what rss says.
      const unit = process.memoryUsage().rss / r0 > 100 ? 1024 : 1
      const mb = ((process.resourceUsage().maxRSS - r0) * unit) / 2 ** 20
      console.log(JSON.stringify({ reason: idx.skipped[0]?.reason, mb }))
    `
    const run = Bun.spawnSync([process.execPath, '-e', script])
    const { reason, mb } = JSON.parse(run.stdout.toString())
    expect(reason).toBe('not-tiled') // only the memory matters
    expect(mb).toBeLessThan(300)
  })

  test('a value claiming to run past the file is malformed, not a whole-file read', async () => {
    const lying = dicom({
      note: el(0x0009, 0x1010, 'UT', str('x'), 0xfffffff0),
    })
    const idx = await indexDicomWsi([lying])
    expect(idx.skipped[0]?.reason).toBe('malformed')
    expect(idx.skipped[0]?.message).toMatch(/runs past the file/)
  })

  test('an element header straddling the first 1 MiB read reads more', async () => {
    const pixelLength = pixelData([0, 1, 2, 3].map(payload)).length
    const pad = (n: number) => el(0x0009, 0x1010, 'OB', new Uint8Array(n))
    const next = el(0x0009, 0x1011, 'LO', str('x'))
    // Where the element after an empty pad starts.
    const head = dicom({ pad: pad(0), next }).size - pixelLength - next.length
    // The next header starts 1..7 bytes before the 1 MiB mark: its tag, VR or
    // length runs past the first read.
    for (let k = 1; k < 8; k++) {
      const file = dicom({ pad: pad((1 << 20) - k - head), next })
      const idx = await indexDicomWsi([file])
      expect(idx.skipped).toEqual([])
      expect(
        await tileLabels(idx.slides[0] as SlideIndexSlide, [file]),
      ).toEqual([0, 1, 2, 3])
    }
  })

  test('Pixel Data that is not OB/OW, or lacks its offset-table item, is malformed', async () => {
    const pixel = pixelData([0, 1, 2, 3].map(payload))
    const ow = pixel.slice()
    ow.set(new TextEncoder().encode('UN'), 4)
    expect(await reasons(dicom({}, ow))).toEqual(['malformed'])
    const noItem = pixel.slice()
    noItem[12] = 0 // the Basic Offset Table item tag
    expect(await reasons(dicom({}, noItem))).toEqual(['malformed'])
  })

  test('an offset table that is not increasing falls back to walking the items', async () => {
    const step = 8 + 6 // one fragment: item header + payload
    const shuffled = dicom(
      {},
      pixelData([0, 1, 2, 3].map(payload), [step, 0, 3 * step, 2 * step]),
    )
    const idx = await indexDicomWsi([shuffled])
    expect(idx.skipped).toEqual([])
    expect(
      await tileLabels(idx.slides[0] as SlideIndexSlide, [shuffled]),
    ).toEqual([0, 1, 2, 3])
    const pastEnd = dicom(
      {},
      pixelData([0, 1, 2, 3].map(payload), [0, step, 2 * step, 1e9]),
    )
    const idx2 = await indexDicomWsi([pastEnd])
    expect(
      await tileLabels(idx2.slides[0] as SlideIndexSlide, [pastEnd]),
    ).toEqual([0, 1, 2, 3])
  })

  test('per-frame positions that are not a tile origin are errors, never tile 0,0', async () => {
    const pos = (column: number, row: number) =>
      item(
        sq(0x0048, 0x021a, [
          item(
            el(0x0048, 0x021e, 'SL', le(column >>> 0, 4)),
            el(0x0048, 0x021f, 'SL', le(row >>> 0, 4)),
          ),
        ]),
      )
    const sparse = dicom({
      org: el(0x0020, 0x9311, 'CS', str('TILED_SPARSE')),
      // Frames 0 and 1 are not tile origins (column 9 of 16-px tiles; column 0,
      // as positions are 1-based); truncating them would claim tile 0,0 first.
      // Frame 2 is the real top-left tile; frame 3 the bottom right.
      perFrame: sq(0x5200, 0x9230, [
        pos(9, 1),
        pos(0, 1),
        pos(1, 1),
        pos(17, 17),
      ]),
    })
    const idx = await indexDicomWsi([sparse])
    const slide = idx.slides[0] as SlideIndexSlide
    expect(slide.levels[0]?.duplicates).toBe(2)
    expect(await tileLabels(slide, [sparse])).toEqual([2, -1, -1, 3])
    expect(new DicomWsiSource(slide, [sparse]).manifest.backgroundColor).toBe(
      undefined,
    )
    // RecommendedAbsentPixelCIELabValue colours the holes (white here).
    const white = dicom({
      org: el(0x0020, 0x9311, 'CS', str('TILED_SPARSE')),
      absentLab: el(
        0x0048,
        0x0015,
        'US',
        cat(le(0xffff, 2), le(0x8080, 2), le(0x8080, 2)),
      ),
      perFrame: sq(0x5200, 0x9230, [
        pos(9, 1),
        pos(0, 1),
        pos(1, 1),
        pos(17, 17),
      ]),
    })
    // Through the public entry, whichever module implements it.
    const { indexDicomWsi: indexViaEntry } = await import('./dicom')
    const ws = (await indexViaEntry([white])).slides[0] as SlideIndexSlide
    const { manifest } = new DicomWsiSource(ws, [white])
    expect(manifest.backgroundColor).toEqual([1, 1, 1, 1])
    // The tag is VM 3: a fourth component makes it invalid, not white.
    const four = dicom({
      org: el(0x0020, 0x9311, 'CS', str('TILED_SPARSE')),
      absentLab: el(
        0x0048,
        0x0015,
        'US',
        cat(le(0xffff, 2), le(0x8080, 2), le(0x8080, 2), le(1, 2)),
      ),
      perFrame: sq(0x5200, 0x9230, [
        pos(9, 1),
        pos(0, 1),
        pos(1, 1),
        pos(17, 17),
      ]),
    })
    const fs = (await indexViaEntry([four])).slides[0] as SlideIndexSlide
    expect(new DicomWsiSource(fs, [four]).manifest.backgroundColor).toBe(
      undefined,
    )
    expect(manifest.levels[0]?.tiles.map((t) => t === null)).toEqual([
      false,
      true,
      true,
      false,
    ])
  })
  // Per-frame z for a sparse level of 1-px tiles on a 2048 x 2048 grid.
  const planes = (zs: string[]) =>
    dicom(
      {
        org: el(0x0020, 0x9311, 'CS', str('TILED_SPARSE')),
        frames: el(0x0028, 0x0008, 'IS', str(String(zs.length))),
        rows: el(0x0028, 0x0010, 'US', le(1, 2)),
        columns: el(0x0028, 0x0011, 'US', le(1, 2)),
        totalColumns: el(0x0048, 0x0006, 'UL', le(2048, 4)),
        totalRows: el(0x0048, 0x0007, 'UL', le(2048, 4)),
        perFrame: sq(
          0x5200,
          0x9230,
          zs.map((z) =>
            item(
              sq(0x0048, 0x021a, [
                item(
                  el(0x0048, 0x021e, 'SL', le(1, 4)),
                  el(0x0048, 0x021f, 'SL', le(1, 4)),
                  el(0x0040, 0x074a, 'DS', str(z)),
                ),
              ]),
            ),
          ),
        ),
      },
      pixelData(zs.map((_, k) => payload(k & 255))),
    )

  test('thousands of focal planes are refused, not made into slides', async () => {
    const t0 = performance.now()
    const idx = await indexDicomWsi([
      planes(Array.from({ length: 5000 }, (_, k) => String(k))),
    ])
    expect(idx.slides).toEqual([])
    expect(idx.skipped.map((s) => s.reason)).toEqual(['malformed'])
    expect(performance.now() - t0).toBeLessThan(2000)
  })

  test('a non-finite focal plane is malformed', async () => {
    expect(await reasons(planes(['abc']))).toEqual(['malformed'])
  })

  test('a Basic Offset Table whose last entry misses its item is walked instead', async () => {
    const step = 14 // item header + 6-byte payload
    const f = dicom(
      {},
      pixelData([0, 1, 2, 3].map(payload), [0, step, 2 * step, 3 * step + 2]),
    )
    const idx = await indexDicomWsi([f])
    expect(idx.skipped).toEqual([])
    const lengths = [...(idx.slides[0]?.levels[0]?.frames.length ?? [])]
    expect(lengths).toEqual([6, 6, 6, 6])
    expect(await tileLabels(idx.slides[0] as SlideIndexSlide, [f])).toEqual([
      0, 1, 2, 3,
    ])
  })
  test('TILED_FULL with per-frame metadata but no positions keeps its implicit order', async () => {
    // Frame Content (0020,9111) > Frame Acquisition Number (0020,9156) only.
    const content = (k: number) =>
      item(sq(0x0020, 0x9111, [item(el(0x0020, 0x9156, 'US', le(k, 2)))]))
    const f = dicom({ perFrame: sq(0x5200, 0x9230, [0, 1, 2, 3].map(content)) })
    const idx = await indexDicomWsi([f])
    expect(idx.skipped).toEqual([])
    const slide = idx.slides[0] as SlideIndexSlide
    expect(slide.levels[0]?.duplicates).toBe(0)
    expect(await tileLabels(slide, [f])).toEqual([0, 1, 2, 3])
  })
  test('a level stating ZOffset and one that does not form one slide', async () => {
    const l0 = dicom({
      sop: el(0x0008, 0x0018, 'UI', str('1.2.9.10', '\0')),
      shared: sq(0x5200, 0x9229, [item(zSeq('1.5'))]),
    })
    const l1 = dicom(
      {
        sop: el(0x0008, 0x0018, 'UI', str('1.2.9.11', '\0')),
        frames: el(0x0028, 0x0008, 'IS', str('1')),
        totalColumns: el(0x0048, 0x0006, 'UL', le(16, 4)),
        totalRows: el(0x0048, 0x0007, 'UL', le(16, 4)),
      },
      pixelData([payload(9)]),
    )
    const idx = await indexDicomWsi([l0, l1])
    expect(idx.skipped).toEqual([])
    expect(idx.slides.map((s) => s.levels.length)).toEqual([2])
  })

  test('ZOffset on only some frames is malformed', async () => {
    const zItem = (z?: string) =>
      item(
        z === undefined
          ? sq(0x0020, 0x9111, [item(el(0x0020, 0x9156, 'US', le(1, 2)))])
          : sq(0x0048, 0x021a, [item(el(0x0040, 0x074a, 'DS', str(z)))]),
      )
    const f = dicom({
      perFrame: sq(0x5200, 0x9230, [zItem('1'), zItem('2'), zItem(), zItem()]),
    })
    expect(await reasons(f)).toEqual(['malformed'])
  })
  test('a concatenation split across focal planes keeps every plane', async () => {
    // 2 tiles per plane, 3 planes: part 1 holds frames 0-3, part 2 frames 4-5.
    const part = (n: number, offset: number, frames: number[]) =>
      dicom(
        {
          sop: el(0x0008, 0x0018, 'UI', str(`1.2.9.2${n}`, '\0')),
          frames: el(0x0028, 0x0008, 'IS', str(String(frames.length))),
          totalColumns: el(0x0048, 0x0006, 'UL', le(32, 4)),
          totalRows: el(0x0048, 0x0007, 'UL', le(16, 4)),
          concatNumber: el(0x0020, 0x9162, 'US', le(n, 2)),
          concatOffset: el(0x0020, 0x9228, 'UL', le(offset, 4)),
          focalPlanes: el(0x0048, 0x0303, 'UL', le(3, 4)),
        },
        pixelData(frames.map(payload)),
      )
    const idx = await indexDicomWsi([
      part(1, 0, [0, 1, 2, 3]),
      part(2, 4, [4, 5]),
    ])
    expect(idx.skipped).toEqual([])
    expect(
      idx.slides.map((s) => [s.focalPlane, s.levels[0]?.duplicates]),
    ).toEqual([
      [0, 0],
      [1, 0],
      [2, 0],
    ])
  })
  // Planes rank across the joined slide, also when each level has its own frame of reference.
  test.each([
    false,
    true,
  ])('a lower level holding only some planes joins the planes it holds (own frame of reference: %p)', async (ownFrame) => {
    // Level 0: 2 x 1 tiles at 0 and 2 µm; level 1: one tile at 2 µm only.
    // FrameOfReferenceUID (0020,0052) goes right after the series, in tag order.
    const frameOf = (uid: string) => ({
      series: cat(
        el(0x0020, 0x000e, 'UI', str('1.2.9.3', '\0')),
        ownFrame ? el(0x0020, 0x0052, 'UI', str(uid, '\0')) : new Uint8Array(),
      ),
    })
    const l0 = dicom({
      ...frameOf('1.2.9.50'),
      sop: el(0x0008, 0x0018, 'UI', str('1.2.9.40', '\0')),
      totalRows: el(0x0048, 0x0007, 'UL', le(16, 4)),
      focalPlanes: el(0x0048, 0x0303, 'UL', le(2, 4)),
      perFrame: sq(
        0x5200,
        0x9230,
        ['0', '0', '2', '2'].map((z) => item(zSeq(z))),
      ),
    })
    const l1 = dicom(
      {
        sop: el(0x0008, 0x0018, 'UI', str('1.2.9.41', '\0')),
        ...frameOf('1.2.9.51'),
        frames: el(0x0028, 0x0008, 'IS', str('1')),
        totalColumns: el(0x0048, 0x0006, 'UL', le(16, 4)),
        totalRows: el(0x0048, 0x0007, 'UL', le(16, 4)),
        perFrame: sq(0x5200, 0x9230, [item(zSeq('2'))]),
      },
      pixelData([payload(9)]),
    )
    const idx = await indexDicomWsi([l0, l1])
    expect(idx.skipped).toEqual([])
    expect(planesOf(idx)).toEqual([
      [0, [[32, 2, 0]]],
      [
        1,
        [
          [32, 2, 0],
          [16, 1, 0],
        ],
      ],
    ])
  })

  test('one plane per file, stated once per file, stays two slides', async () => {
    const plane = (uid: string, z: string) =>
      dicom({
        sop: el(0x0008, 0x0018, 'UI', str(uid, '\0')),
        shared: sq(0x5200, 0x9229, [item(zSeq(z))]),
      })
    expect(
      planesOf(
        await indexDicomWsi([plane('1.2.9.50', '1'), plane('1.2.9.51', '2')]),
      ),
    ).toEqual([
      [0, [[32, 4, 0]]],
      [1, [[32, 4, 0]]],
    ])
  })

  test('a frame repeating ZOffset does not count as two frames', async () => {
    const other = item(
      sq(0x0020, 0x9111, [item(el(0x0020, 0x9156, 'US', le(1, 2)))]),
    )
    const z55 = item(zSeq('5', '5'))
    const f = dicom({ perFrame: sq(0x5200, 0x9230, [z55, z55, other, other]) })
    expect(await reasons(f)).toEqual(['malformed'])
  })
  test('one shared ZOffset does not collapse several implicit planes', async () => {
    const f = dicom({
      totalRows: el(0x0048, 0x0007, 'UL', le(16, 4)),
      focalPlanes: el(0x0048, 0x0303, 'UL', le(2, 4)),
      shared: sq(0x5200, 0x9229, [item(zSeq('5'))]),
    })
    expect(planesOf(await indexDicomWsi([f]))).toEqual([
      [0, [[32, 2, 0]]],
      [1, [[32, 2, 0]]],
    ])
  })
  test('many files each naming a full-size plane index without grid-sized maps', async () => {
    // 2048 x 2048 one-pixel tiles (4M) per file: a map is built only on open.
    const plane = (k: number) =>
      dicom(
        {
          sop: el(0x0008, 0x0018, 'UI', str(`1.2.9.9${k}`, '\0')),
          org: el(0x0020, 0x9311, 'CS', str('TILED_SPARSE')),
          frames: el(0x0028, 0x0008, 'IS', str('1')),
          rows: el(0x0028, 0x0010, 'US', le(1, 2)),
          columns: el(0x0028, 0x0011, 'US', le(1, 2)),
          totalColumns: el(0x0048, 0x0006, 'UL', le(2048, 4)),
          totalRows: el(0x0048, 0x0007, 'UL', le(2048, 4)),
          shared: sq(0x5200, 0x9229, [item(zSeq(String(k)))]),
          perFrame: sq(0x5200, 0x9230, [
            item(
              sq(0x0048, 0x021a, [
                item(
                  el(0x0048, 0x021e, 'SL', le(1, 4)),
                  el(0x0048, 0x021f, 'SL', le(1, 4)),
                ),
              ]),
            ),
          ]),
        },
        pixelData([payload(k)]),
      )
    const idx = await indexDicomWsi(
      Array.from({ length: 20 }, (_, k) => plane(k)),
    )
    expect(idx.skipped).toEqual([])
    expect(idx.slides.map((s) => s.levels[0]?.holes)).toEqual(
      Array(20).fill(2048 * 2048 - 1),
    )
    const map = tileMap(idx.slides[19]?.levels[0] as SlideIndexLevel)
    expect([map.length, map[0]]).toEqual([2048 * 2048, 0])
  })

  test('levels stating nearly equal ZOffsets share a plane', async () => {
    const level = (uid: string, z: string, frames = 4, size = 32) =>
      dicom(
        {
          sop: el(0x0008, 0x0018, 'UI', str(uid, '\0')),
          frames: el(0x0028, 0x0008, 'IS', str(String(frames))),
          totalColumns: el(0x0048, 0x0006, 'UL', le(size, 4)),
          totalRows: el(0x0048, 0x0007, 'UL', le(size, 4)),
          shared: sq(0x5200, 0x9229, [item(zSeq(z))]),
        },
        pixelData(Array.from({ length: frames }, (_, k) => payload(k))),
      )
    const idx = await indexDicomWsi([
      level('1.2.9.95', '0.5'),
      level('1.2.9.96', '0.5000001', 1, 16),
    ])
    expect(planesOf(idx)).toEqual([
      [
        0,
        [
          [32, 4, 0],
          [16, 1, 0],
        ],
      ],
    ])
  })
  test('a file naming thousands of optical paths is refused quickly', async () => {
    const N = 5000
    const frame = (k: number) =>
      item(
        sq(0x0048, 0x0207, [item(el(0x0048, 0x0106, 'SH', str(`p${k}`)))]),
        sq(0x0048, 0x021a, [
          item(
            el(0x0048, 0x021e, 'SL', le(1, 4)),
            el(0x0048, 0x021f, 'SL', le(1, 4)),
          ),
        ]),
      )
    const f = dicom(
      {
        org: el(0x0020, 0x9311, 'CS', str('TILED_SPARSE')),
        frames: el(0x0028, 0x0008, 'IS', str(String(N))),
        perFrame: sq(
          0x5200,
          0x9230,
          Array.from({ length: N }, (_, k) => frame(k)),
        ),
      },
      pixelData(Array.from({ length: N }, (_, k) => payload(k & 255))),
    )
    const t0 = performance.now()
    expect((await indexDicomWsi([f])).skipped.map((k) => k.message)).toEqual([
      'over 4096 (optical path, focal plane) pairs',
    ])
    expect(performance.now() - t0).toBeLessThan(1000)
  })
  test('TILED_FULL frames past tiles x planes x paths are malformed, quickly', async () => {
    const f = dicom(
      {
        frames: el(0x0028, 0x0008, 'IS', str('1')),
        totalColumns: el(0x0048, 0x0006, 'UL', le(16, 4)),
        totalRows: el(0x0048, 0x0007, 'UL', le(16, 4)),
        concatOffset: el(0x0020, 0x9228, 'UL', le(100_000_000, 4)),
      },
      pixelData([payload(0)]),
    )
    const t0 = performance.now()
    expect(await reasons(f)).toEqual(['malformed'])
    expect(performance.now() - t0).toBeLessThan(100)
  })

  test('near-equal levels past twice the grid cap are dropped from the slide', async () => {
    // One-pixel tiles: each level is about 4M tiles, so two fit under 2 x 2^22.
    const level = (k: number) => {
      const size = 2048 - k
      return dicom(
        {
          sop: el(0x0008, 0x0018, 'UI', str(`1.2.9.7${k}`, '\0')),
          org: el(0x0020, 0x9311, 'CS', str('TILED_SPARSE')),
          frames: el(0x0028, 0x0008, 'IS', str('1')),
          rows: el(0x0028, 0x0010, 'US', le(1, 2)),
          columns: el(0x0028, 0x0011, 'US', le(1, 2)),
          totalColumns: el(0x0048, 0x0006, 'UL', le(size, 4)),
          totalRows: el(0x0048, 0x0007, 'UL', le(size, 4)),
          perFrame: sq(0x5200, 0x9230, [
            item(
              sq(0x0048, 0x021a, [
                item(
                  el(0x0048, 0x021e, 'SL', le(1, 4)),
                  el(0x0048, 0x021f, 'SL', le(1, 4)),
                ),
              ]),
            ),
          ]),
        },
        pixelData([payload(k)]),
      )
    }
    const files = Array.from(
      { length: 20 },
      (_, k) => new File([level(k)], `L${k}.dcm`, { lastModified: 1 }),
    )
    const idx = await indexDicomWsi(files)
    expect(idx.slides.map((s) => s.levels.map((l) => l.width))).toEqual([
      [2048, 2047],
    ])
    expect(idx.skipped.map((k) => k.file)).toEqual(
      files.slice(2).map((f) => f.name),
    )
    // Dropped files are not the slide's, so opening needs only the kept two.
    expect(idx.slides[0]?.instances.map((i) => i.file)).toEqual([
      'L0.dcm',
      'L1.dcm',
    ])
  })
  test('no organization type with per-frame positions is placed by them, not implicitly', async () => {
    // 2 focal planes x 4 tiles, positions and ZOffset per frame, no counts.
    const at = (c: number, r: number, z: string) =>
      item(
        sq(0x0048, 0x021a, [
          item(
            el(0x0048, 0x021e, 'SL', le(c, 4)),
            el(0x0048, 0x021f, 'SL', le(r, 4)),
            el(0x0040, 0x074a, 'DS', str(z)),
          ),
        ]),
      )
    const grid = [
      [1, 1],
      [17, 1],
      [1, 17],
      [17, 17],
    ] as const
    const f = dicom(
      {
        org: null,
        frames: el(0x0028, 0x0008, 'IS', str('8')),
        perFrame: sq(0x5200, 0x9230, [
          ...grid.map(([c, r]) => at(c, r, '0')),
          ...grid.map(([c, r]) => at(c, r, '2')),
        ]),
      },
      pixelData(Array.from({ length: 8 }, (_, k) => payload(k))),
    )
    const idx = await indexDicomWsi([f])
    expect(idx.skipped).toEqual([])
    expect(idx.slides.map((s) => [s.opticalPath, s.focalPlane])).toEqual([
      ['0', 0],
      ['0', 1],
    ])
    expect(planesOf(idx)).toEqual([
      [0, [[32, 4, 0]]],
      [1, [[32, 4, 0]]],
    ])
  })

  test('a full grid with a duplicated position is sparse, so it opens, first frame winning', async () => {
    const at = (c: number, r: number) =>
      item(
        sq(0x0048, 0x021a, [
          item(
            el(0x0048, 0x021e, 'SL', le(c, 4)),
            el(0x0048, 0x021f, 'SL', le(r, 4)),
          ),
        ]),
      )
    const f = dicom(
      {
        org: null,
        frames: el(0x0028, 0x0008, 'IS', str('5')),
        perFrame: sq(0x5200, 0x9230, [
          at(1, 1),
          at(17, 1),
          at(1, 17),
          at(17, 17),
          at(1, 1),
        ]),
      },
      pixelData(Array.from({ length: 5 }, (_, k) => payload(k))),
    )
    const slide = (await indexDicomWsi([f])).slides[0] as SlideIndexSlide
    const l0 = slide.levels[0]
    expect([l0?.holes, l0?.duplicates, l0?.sparse]).toEqual([0, 1, true])
    // What NVSlide's assertSingleSlidePlane passes: 5 frames on 4 tiles are not a dense grid.
    expect(new DicomWsiSource(slide, [f]).manifest.levels[0]).toMatchObject({
      sparse: true,
      opticalPaths: 1,
      focalPlanes: 1,
    })
    expect(await tileLabels(slide, [f])).toEqual([0, 1, 2, 3])
  })

  test('no ImageType: a stated multi-tile matrix is a level, a single-tile macro is not', async () => {
    const volume = await indexDicomWsi([dicom({ imageType: null })])
    expect(volume.slides.map((s) => s.levels.map((l) => l.width))).toEqual([
      [32],
    ])
    const one = { frames: el(0x0028, 0x0008, 'IS', str('1')) }
    const macro = (over: Record<string, Uint8Array | null>) =>
      dicom({ imageType: null, ...one, ...over }, pixelData([payload(0)]))
    for (const f of [
      macro({
        totalColumns: el(0x0048, 0x0006, 'UL', le(16, 4)),
        totalRows: el(0x0048, 0x0007, 'UL', le(16, 4)),
      }),
      macro({ totalColumns: null, totalRows: null }),
    ])
      expect((await indexDicomWsi([f])).slides).toEqual([])
    // A stated type without VOLUME stays out, whatever its geometry.
    const label = dicom({
      imageType: el(
        0x0008,
        0x0008,
        'CS',
        str('ORIGINAL\\PRIMARY\\LABEL\\NONE'),
      ),
    })
    expect((await indexDicomWsi([label])).slides).toEqual([])
  })

  test('a TILED_SPARSE file with an empty NumberOfOpticalPaths still indexes', async () => {
    const pos = (c: number, r: number) =>
      item(
        sq(0x0048, 0x021a, [
          item(
            el(0x0048, 0x021e, 'SL', le(c, 4)),
            el(0x0048, 0x021f, 'SL', le(r, 4)),
          ),
        ]),
      )
    const f = dicom({
      org: el(0x0020, 0x9311, 'CS', str('TILED_SPARSE')),
      opticalPaths: el(0x0048, 0x0302, 'UL', new Uint8Array(0)),
      perFrame: sq(0x5200, 0x9230, [
        pos(1, 1),
        pos(17, 1),
        pos(1, 17),
        pos(17, 17),
      ]),
    })
    const idx = await indexDicomWsi([f])
    expect(idx.skipped).toEqual([])
    expect(idx.slides).toHaveLength(1)
  })
  test('DicomWsiSource serves the optical path ICC profile from the level-0 file', async () => {
    const icc = Uint8Array.from({ length: 200 }, (_, i) => (i * 3) & 255)
    const f = dicom({
      opticalPathSeq: sq(0x0048, 0x0105, [
        item(el(0x0028, 0x2000, 'OB', icc), el(0x0048, 0x0106, 'SH', str('1'))),
      ]),
    })
    const idx = await indexDicomWsi([f])
    const slide = idx.slides[0] as SlideIndexSlide
    expect(slide.iccProfile?.length).toBe(200)
    expect(await new DicomWsiSource(slide, [f]).fetchIccProfile()).toEqual(icc)
    const plain = dicom()
    const plainSlide = (await indexDicomWsi([plain]))
      .slides[0] as SlideIndexSlide
    expect(
      await new DicomWsiSource(plainSlide, [plain]).fetchIccProfile(),
    ).toBeNull()
  })
})
