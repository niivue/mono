import { describe, expect, test } from 'bun:test'
import { indexDicomWsi, type SlideIndexSlide } from './dicomIndex'
import { DicomWsiSource } from './dicomWsiSource'

// Hostile and malformed inputs, built byte by byte here (explicit VR little
// endian), so each test states exactly what is wrong with its file.

const LONG = new Set('OB OD OF OL OV OW SQ SV UC UN UR UT UV'.split(' '))
const UNDEF = 0xffffffff
const cat = (...parts: Uint8Array[]): Uint8Array => {
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
    expect(await reasons(giant)).toEqual(['malformed'])
  })

  test('a value claiming to run past the file is malformed, not a whole-file read', async () => {
    const lying = dicom({
      note: el(0x0009, 0x1010, 'UT', str('x'), 0xfffffff0),
    })
    const idx = await indexDicomWsi([lying])
    expect(idx.skipped[0]?.reason).toBe('malformed')
    expect(idx.skipped[0]?.message).toMatch(/runs past the file/)
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
      planes(Array.from({ length: 3000 }, (_, k) => String(k))),
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
  test('a lower level holding only some planes joins the planes it holds', async () => {
    // Level 0: 2 x 1 tiles at 0 and 2 µm; level 1: one tile at 2 µm only.
    const l0 = dicom({
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
        frames: el(0x0028, 0x0008, 'IS', str('1')),
        totalColumns: el(0x0048, 0x0006, 'UL', le(16, 4)),
        totalRows: el(0x0048, 0x0007, 'UL', le(16, 4)),
        perFrame: sq(0x5200, 0x9230, [item(zSeq('2'))]),
      },
      pixelData([payload(9)]),
    )
    expect(planesOf(await indexDicomWsi([l0, l1]))).toEqual([
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
})
