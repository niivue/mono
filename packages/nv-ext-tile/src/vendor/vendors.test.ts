import { describe, expect, test } from 'bun:test'
import { argosStack } from './argos'
import { leicaComposition, leicaRegions } from './leica'
import { philipsLevels } from './philips'
import { trestleOverlaps, trestlePlacement } from './trestle'

describe('Trestle', () => {
  // CMU-1.tif (OpenSlide Trestle/CMU-1.zip), ImageDescription and IFD sizes.
  const desc =
    'Background Color=E6E6E6;White Balance=C0AAA1;Objective Power=10;JPEG Quality=75;OverlapsXY= 64 64 32 32 16 16\0'
  test('reads the per-level overlaps', () => {
    expect(trestleOverlaps(desc)).toEqual([
      [64, 64],
      [32, 32],
      [16, 16],
    ])
    expect(trestleOverlaps('Objective Power=10')).toBeNull()
  })

  test('places CMU-1 levels at their stitched size; overlaps split at the midpoint', () => {
    const level = (
      width: number,
      height: number,
      tw: number,
      th: number,
      d: number,
    ) => ({
      width,
      height,
      tileWidth: tw,
      tileHeight: th,
      columns: Math.ceil(width / tw),
      rows: Math.ceil(height / th),
      downsample: d,
    })
    const p = trestlePlacement(trestleOverlaps(desc) ?? [], [
      level(46592, 33792, 448, 352, 1),
      level(21632, 15360, 416, 320, 2),
      level(10400, 7296, 400, 304, 4),
      level(4992, 3456, 256, 256, 8),
    ])
    expect([p.width, p.height]).toEqual([40000, 27712])
    expect(p.levels.map((l) => l.width)).toEqual([40000, 20000, 10000, 4992])
    const l0 = p.levels[0]?.pieces ?? []
    expect(l0[0]).toEqual({
      tile: 0,
      sx: 0,
      sy: 0,
      sw: 416,
      sh: 320,
      dx: 0,
      dy: 0,
    })
    // Tile (1,1): 32 px cropped each interior side, drawn at 384+32, 288+32.
    expect(l0[105]).toEqual({
      tile: 105,
      sx: 32,
      sy: 32,
      sw: 384,
      sh: 288,
      dx: 416,
      dy: 320,
    })
    // Level 3 states no overlap: whole tiles on the grid.
    expect(p.levels[3]?.pieces[1]).toMatchObject({ sx: 0, sw: 256, dx: 256 })
  })
})

describe('Trestle edge tiles', () => {
  test('an edge tile shorter than half the overlap adds no piece and leaves no gap', () => {
    // 2 x 2 tiles of 16 with an 8 px overlap; the last column and row hold 2 px.
    const level = {
      tileWidth: 16,
      tileHeight: 16,
      columns: 2,
      rows: 2,
      width: 18,
      height: 18,
      downsample: 1,
    }
    const p = trestlePlacement([[8, 8]], [level]).levels[0]
    if (!p) throw new Error('no level')
    expect([p.width, p.height]).toEqual([10, 10])
    for (const q of p.pieces) {
      expect(q.sw).toBeGreaterThan(0)
      expect(q.sh).toBeGreaterThan(0)
      expect(q.dx + q.sw).toBeLessThanOrEqual(p.width)
      expect(q.dy + q.sh).toBeLessThanOrEqual(p.height)
    }
    expect(p.pieces).toEqual([
      { tile: 0, sx: 0, sy: 0, sw: 10, sh: 10, dx: 0, dy: 0 },
    ])
  })
})

describe('Philips', () => {
  const rep = (n: number, columns: number, rows: number, spacing: string) =>
    `<DataObject ObjectType="PixelDataRepresentation"><Attribute Name="DICOM_PIXEL_SPACING" PMSVR="IDoubleArray">&quot;${spacing}&quot; &quot;${spacing}&quot;</Attribute><Attribute Name="PIIM_PIXEL_DATA_REPRESENTATION_COLUMNS">${columns}</Attribute><Attribute Name="PIIM_PIXEL_DATA_REPRESENTATION_NUMBER">${n}</Attribute><Attribute Name="PIIM_PIXEL_DATA_REPRESENTATION_ROWS">${rows}</Attribute></DataObject>`
  const xml = (...r: string[]) =>
    `<DataObject ObjectType="DPUfsImport"><Array>${r.join('')}</Array></DataObject>`

  test('Philips-1: printed spacings snap to powers of two', () => {
    expect(
      philipsLevels(
        xml(
          rep(0, 45056, 35840, '0.000227273'),
          rep(1, 22528, 17920, '0.000454545'),
          rep(2, 11264, 9216, '0.000909091'),
        ),
      ),
    ).toEqual([
      { columns: 45056, rows: 35840, downsample: 1 },
      { columns: 22528, rows: 17920, downsample: 2 },
      { columns: 11264, rows: 9216, downsample: 4 },
    ])
  })

  test('a factor other than a power of two is kept', () => {
    const l = philipsLevels(
      xml(rep(1, 512, 512, '0.0015'), rep(0, 1536, 1024, '0.0005')),
    )
    expect(l?.map((v) => v.downsample)).toEqual([1, 3])
    expect(philipsLevels('<DataObject ObjectType="DPUfsImport"/>')).toBeNull()
    expect(philipsLevels('<OME/>')).toBeNull()
  })
})

describe('Argos', () => {
  const meta = (min: number, max: number) =>
    `<Argos.Scan.Metadata><ZRange>8</ZRange><MinZ>${min}</MinZ><MaxZ>${max}</MaxZ></Argos.Scan.Metadata>`
  const pyramid = [130546, 65273, 32636, 16318].map((w) => ({
    width: w,
    height: Math.floor(w * 0.44),
    tiled: true,
  }))
  const strips = [
    { width: 3180, height: 1399, tiled: false },
    { width: 1489, height: 508, tiled: false },
  ]

  test('Argos-1-Stacked: 5 planes of one pyramid each, the middle by default', () => {
    const images = [
      ...pyramid,
      ...pyramid,
      ...pyramid,
      ...pyramid,
      ...pyramid,
      ...strips,
    ]
    const s = argosStack(meta(-2, 2), images)
    expect(s?.planes.length).toBe(5)
    expect(s?.planes[2]).toEqual([8, 9, 10, 11])
    expect(s?.middle).toBe(2)
  })

  test('a single plane or a mismatched chain is not a stack', () => {
    expect(argosStack(meta(0, 0), [...pyramid, ...strips])).toBeNull()
    expect(argosStack(meta(-1, 1), [...pyramid, ...pyramid])).toBeNull()
    expect(
      argosStack(meta(0, 1), [
        ...pyramid,
        ...pyramid.slice(1),
        pyramid[0] as (typeof pyramid)[0],
      ]),
    ).toBeNull()
    expect(argosStack('<OME/>', pyramid)).toBeNull()
  })
})

describe('Leica', () => {
  // Leica-2.scn, trimmed: the macro and two of its four 40x regions.
  const image = (
    w: number,
    h: number,
    ifd0: number,
    x: number,
    y: number,
    vw: number,
    vh: number,
  ) =>
    `<image><pixels sizeX="${w}" sizeY="${h}"><dimension sizeX="${w}" sizeY="${h}" r="0" ifd="${ifd0}" /><dimension sizeX="${w / 4}" sizeY="${h / 4}" r="1" ifd="${ifd0 + 1}" /></pixels><view sizeX="${vw}" sizeY="${vh}" offsetX="${x}" offsetY="${y}" spacingZ="400" /><illuminationSource>brightfield</illuminationSource></image>`
  const xml = `<?xml version="1.0"?><scn><collection sizeX="26564529" sizeY="76734666">${image(1616, 4668, 0, 0, 0, 26564529, 76734666)}${image(39168, 26048, 3, 10317168, 18642978, 9792000, 6512000)}${image(39360, 23360, 9, 10370790, 12536174, 9840000, 5840000)}</collection></scn>`

  test('skips the macro and keeps the regions with their IFDs and views', () => {
    const r = leicaRegions(xml)
    expect(r?.map((v) => v.ifds)).toEqual([
      [3, 4],
      [9, 10],
    ])
    expect(r?.[0]?.view).toEqual({
      x: 10317168,
      y: 18642978,
      width: 9792000,
      height: 6512000,
    })
    expect(leicaRegions('<OME/>')).toBeNull()
  })

  test('composes regions side by side in one grid, placed at their views (250 nm px)', () => {
    const regions = leicaRegions(xml) ?? []
    const lv = (w: number, h: number) => ({
      width: w,
      height: h,
      tileWidth: 512,
      tileHeight: 512,
    })
    const { grids, placement } = leicaComposition(regions, [
      [lv(39168, 26048), lv(9792, 6512)],
      [lv(39360, 23360), lv(9840, 5840)],
    ])
    expect(grids[0]).toMatchObject({
      columns: 77 + 77,
      rows: 51,
      colStart: [0, 77],
    })
    // Collection extent of both views in 250 nm px.
    expect(placement.width).toBe(
      Math.round((10370790 + 9840000 - 10317168) / 250),
    )
    expect(placement.height).toBe(
      Math.round((18642978 + 6512000 - 12536174) / 250),
    )
    const l0 = placement.levels[0]?.pieces ?? []
    // Region 1's first tile is grid column 77, drawn at its view offset.
    const first = l0.find((p) => p.tile === 77)
    expect(first?.dx).toBe(Math.round((10370790 - 10317168) / 250))
    expect(first?.dy).toBe(0)
    expect(placement.levels[1]?.width).toBeCloseTo(
      (placement.width * 9792) / 39168,
      6,
    )
  })
})
