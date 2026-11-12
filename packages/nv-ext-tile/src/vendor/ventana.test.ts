import { describe, expect, spyOn, test } from 'bun:test'
import { existsSync } from 'node:fs'
import { fromFile } from '@niivue/geotiff-rs'
import type { StorageLevel } from './placement'
import { isVentanaXmp, ventanaPlacement } from './ventana'

interface Joint {
  dir: string
  t1: number
  t2: number
  ox?: number
  oy?: number
  joined?: 0 | 1
}

// Serpentine frame number of (col, row), as the scanner numbers frames.
const frameNo = (c: number, r: number, cols: number) =>
  r * cols + (r % 2 ? cols - 1 - c : c) + 1

function xmp(
  cols: number,
  rows: number,
  size: number,
  joints: Joint[],
  quote = '"',
): string {
  const q = quote
  const j = joints
    .map(
      ({ dir, t1, t2, ox = 0, oy = 0, joined = 1 }) =>
        `<TileJointInfo FlagJoined=${q}${joined}${q} Confidence=${q}100${q} Direction=${q}${dir}${q} Tile1=${q}${t1}${q} Tile2=${q}${t2}${q} OverlapX=${q}${ox}${q} OverlapY=${q}${oy}${q}/>`,
    )
    .join('\n')
  return `<EncodeInfo Ver="2"><SlideStitchInfo><ImageInfo AOIScanned="1" AOIIndex="0" NumRows="${rows}" NumCols="${cols}" Width="${size}" Height="${size}">\n${j}\n</ImageInfo></SlideStitchInfo><AoiOrigin><AOI0 OriginX="0" OriginY="0"/></AoiOrigin></EncodeInfo>`
}

// Every LEFT/UP joint of a cols x rows grid; `ox(c)` is the overlap of seam c|c+1.
function gridJoints(
  cols: number,
  rows: number,
  ox: (c: number) => number,
  h = 'LEFT',
  v = 'UP',
): Joint[] {
  const out: Joint[] = []
  for (let r = 0; r < rows; r++)
    for (let c = 0; c + 1 < cols; c++)
      out.push({
        dir: h,
        t1: frameNo(c, r, cols),
        t2: frameNo(c + 1, r, cols),
        ox: ox(c),
      })
  for (let r = 0; r + 1 < rows; r++)
    for (let c = 0; c < cols; c++)
      out.push({ dir: v, t1: frameNo(c, r, cols), t2: frameNo(c, r + 1, cols) })
  return out
}

const levelsOf = (
  width: number,
  height: number,
  tile: number,
  count: number,
): StorageLevel[] =>
  Array.from({ length: count }, (_, k) => {
    const d = 2 ** k
    return {
      tileWidth: tile,
      tileHeight: tile,
      columns: Math.ceil(width / d / tile),
      rows: Math.ceil(height / d / tile),
      downsample: d,
    }
  })

const placed = (r: ReturnType<typeof ventanaPlacement>) => {
  if (!('placement' in r)) throw new Error(r.warning)
  return r.placement
}

describe('ventanaPlacement', () => {
  test('a frame grid past MAX_TILES falls back before any per-frame work', () => {
    const warn = spyOn(console, 'warn').mockImplementation(() => {})
    // 2048 x 2048 frames on a storage grid that claims to hold them.
    const placed = ventanaPlacement(
      xmp(2048, 2048, 16, []),
      levelsOf(2048 * 16, 2048 * 16, 16, 1),
    )
    warn.mockRestore()
    expect('warning' in placed && placed.warning).toMatch(/frames, over/)
  })

  test('PL2: 3 frames of 16 px, a 4 px overlap at 1|2, give width 44', () => {
    const p = placed(
      ventanaPlacement(
        xmp(
          3,
          1,
          16,
          gridJoints(3, 1, (c) => (c === 0 ? 4 : 0)),
        ),
        levelsOf(48, 16, 16, 1),
      ),
    )
    expect(p.width).toBe(44)
    expect(p.levels[0]?.pieces).toEqual([
      { tile: 0, sx: 0, sy: 0, sw: 14, sh: 16, dx: 0, dy: 0 },
      // Placed x 14 is frame 2 col 2.
      { tile: 1, sx: 2, sy: 0, sw: 14, sh: 16, dx: 14, dy: 0 },
      { tile: 2, sx: 0, sy: 0, sw: 16, sh: 16, dx: 28, dy: 0 },
    ])
  })

  test('PL3: a seam inside a lower-level tile gives two pieces of one tile; 1.5 px crops are fractional', () => {
    // 8 frames of 16 px, 12 px overlap at 3|4: at L3 (tile 16 = 8 frames of 2 px).
    const p = placed(
      ventanaPlacement(
        xmp(
          8,
          1,
          16,
          gridJoints(8, 1, (c) => (c === 3 ? 12 : 0)),
        ),
        levelsOf(128, 16, 16, 4),
      ),
    )
    const l3 = p.levels[3]?.pieces ?? []
    expect(l3.map((q) => q.tile)).toEqual([0, 0])
    expect(l3[0]).toMatchObject({ sx: 0, sw: 7.25, dx: 0 })
    expect(l3[1]).toMatchObject({ sx: 8.75, sw: 7.25, dx: 7.25 })
    expect(p.levels[3]?.width).toBe(116 / 8)
  })

  test('PL6: an unknown direction, a missing frame or frames past the storage grid open as a grid with a warning', () => {
    const l = levelsOf(32, 32, 16, 1)
    const base = gridJoints(2, 2, () => 0)
    const bad: [Joint[], number][] = [
      [base.map((j, i) => (i ? j : { ...j, dir: 'DIAGONAL' })), 2],
      [[...base, { dir: 'LEFT', t1: 4, t2: 5 }], 2],
      // LEFT between vertical neighbours.
      [
        base.map((j) =>
          j.dir === 'UP' && j.t1 === 1 ? { ...j, dir: 'LEFT' } : j,
        ),
        2,
      ],
      // 3 frame columns on a 2-column storage grid.
      [gridJoints(3, 2, () => 0), 3],
    ]
    for (const [joints, cols] of bad) {
      const r = ventanaPlacement(xmp(cols, 2, 16, joints), l)
      expect('warning' in r && r.warning).toMatch(
        /^Ventana tile joints not applied/,
      )
    }
    expect('warning' in ventanaPlacement('<x/>', l)).toBe(true)
  })

  test('best effort (CCR-V2): an unjoined pair takes the median step, warned once', () => {
    const warn = spyOn(console, 'warn').mockImplementation(() => {})
    // 3 x 1 frames, seam 0|1 overlaps 4; seam 1|2 unjoined.
    const r = ventanaPlacement(
      xmp(3, 1, 16, [{ dir: 'LEFT', t1: 1, t2: 2, ox: 4 }]),
      levelsOf(48, 16, 16, 1),
    )
    if (!('placement' in r)) throw new Error(r.warning)
    expect(r.notice).toMatch(/1 of 2 neighbour pairs unjoined/)
    expect(warn).toHaveBeenCalledTimes(1)
    warn.mockRestore()
    // Frame 2 at 12, frame 3 at 12 + 12 (the median, only, joined step).
    expect(r.placement.width).toBe(40)
    expect(r.seams).toEqual([{ aoi: 0, tile1: 1, tile2: 2, rx: 0, ry: 0 }])
  })

  test('best effort: a disagreeing loop is spread over its seams and recorded', () => {
    const warn = spyOn(console, 'warn').mockImplementation(() => {})
    // 2 x 2 frames; one UP joint states a 4 px x offset the other path lacks.
    const joints = gridJoints(2, 2, () => 0).map((j) =>
      j.dir === 'UP' && j.t1 === 2 ? { ...j, ox: 4 } : j,
    )
    const r = ventanaPlacement(xmp(2, 2, 16, joints), levelsOf(32, 32, 16, 1))
    warn.mockRestore()
    if (!('placement' in r)) throw new Error(r.warning)
    expect(r.notice).toMatch(/largest seam residual/)
    const worst = Math.max(...r.seams.map((s) => Math.abs(s.rx)))
    // Least squares: the 4 px loop error spread over its 4 seams, 1 px each.
    expect(worst).toBeCloseTo(1, 2)
    expect(r.seams.reduce((n, s) => n + Math.abs(s.rx), 0)).toBeCloseTo(4, 2)
  })

  test('two disagreeing joints of one pair: the fit lands midway whichever seeds the tree', () => {
    // Frames 1-2 joined twice: 8 px overlap at confidence 90, 0 px at 10.
    const two = (c1: number, c2: number) =>
      xmp(2, 1, 16, [
        { dir: 'LEFT', t1: 1, t2: 2, ox: 8 },
        { dir: 'LEFT', t1: 1, t2: 2, ox: 0 },
      ]).replace(
        /Confidence="100"([\s\S]*?)Confidence="100"/,
        `Confidence="${c1}"$1Confidence="${c2}"`,
      )
    const warn = spyOn(console, 'warn').mockImplementation(() => {})
    const hi = ventanaPlacement(two(90, 10), levelsOf(32, 16, 16, 1))
    const lo = ventanaPlacement(two(10, 90), levelsOf(32, 16, 16, 1))
    warn.mockRestore()
    if (!('placement' in hi) || !('placement' in lo)) throw new Error('grid')
    // Both seams weigh equally in the fit, so both land midway at 4 px.
    expect(hi.placement.width).toBe(28)
    expect(lo.placement.width).toBe(28)
  })

  test('PL7: RIGHT/DOWN mirrors (tiles swapped) and single quotes give the LEFT/UP result', () => {
    const l = levelsOf(64, 32, 16, 2)
    const joints = gridJoints(4, 2, (c) => (c === 1 ? 6 : 0))
    const a = placed(ventanaPlacement(xmp(4, 2, 16, joints), l))
    const mirrored = joints.map((j) => ({
      ...j,
      dir: j.dir === 'LEFT' ? 'RIGHT' : 'DOWN',
      t1: j.t2,
      t2: j.t1,
    }))
    expect(placed(ventanaPlacement(xmp(4, 2, 16, mirrored, "'"), l))).toEqual(a)
    // The label gives the axis; RIGHT with Tile1 left is the same seam (iScan files).
    const relabelled = joints.map((j) => ({
      ...j,
      dir: j.dir === 'LEFT' ? 'RIGHT' : 'UP',
    }))
    expect(placed(ventanaPlacement(xmp(4, 2, 16, relabelled), l))).toEqual(a)
  })

  test('cross-axis offsets move the right or lower frame against Tile1', () => {
    const p = placed(
      ventanaPlacement(
        xmp(2, 1, 16, [{ dir: 'RIGHT', t1: 1, t2: 2, ox: 4, oy: 2 }]),
        levelsOf(32, 16, 16, 1),
      ),
    )
    // Frame 2 at (12, -2); everything shifts down 2.
    expect(p.levels[0]?.pieces).toEqual([
      { tile: 0, sx: 0, sy: 0, sw: 14, sh: 16, dx: 0, dy: 2 },
      { tile: 1, sx: 2, sy: 0, sw: 14, sh: 16, dx: 14, dy: 0 },
    ])
    expect(p.height).toBe(18)
  })

  test('storage columns past NumCols are never placed', () => {
    // 3 frames on a 4-column storage grid.
    const p = placed(
      ventanaPlacement(
        xmp(
          3,
          1,
          16,
          gridJoints(3, 1, () => 0),
        ),
        levelsOf(64, 16, 16, 2),
      ),
    )
    expect(p.levels[0]?.pieces.map((q) => q.tile)).toEqual([0, 1, 2])
    expect(p.levels[1]?.pieces).toEqual([
      { tile: 0, sx: 0, sy: 0, sw: 16, sh: 8, dx: 0, dy: 0 },
      { tile: 1, sx: 0, sy: 0, sw: 8, sh: 8, dx: 16, dy: 0 },
    ])
  })

  test('isVentanaXmp', () => {
    expect(isVentanaXmp(xmp(1, 1, 16, []))).toBe(false)
    expect(
      isVentanaXmp(
        xmp(
          2,
          1,
          16,
          gridJoints(2, 1, () => 0),
        ),
      ),
    ).toBe(true)
  })
})

// Advisory: the real Ventana-1.bif (CC0, OpenSlide test data), when present.
const BIF = '/Users/chris/src/mono/scratch/ventana/Ventana-1.bif'
describe.skipIf(!existsSync(BIF))('Ventana-1.bif (advisory)', () => {
  test('V7-V10 and PL4/PL5 from the file XMP', async () => {
    const tiff = await fromFile(BIF)
    const l0 = await tiff.getImage(2)
    const text = await l0.fileDirectory.loadValue(700)
    const x =
      typeof text === 'string'
        ? text
        : new TextDecoder().decode(Uint8Array.from(text as ArrayLike<number>))
    const levels = levelsOf(24576, 21504, 1024, 8)
    const p = placed(ventanaPlacement(x, levels))
    // V10 / PL5: 23·1024 − 5·24 wide; column 23 never placed.
    expect([p.width, p.height]).toEqual([23432, 21504])
    expect(p.levels[0]?.pieces.length).toBe(23 * 21)
    expect(p.levels[0]?.pieces.some((q) => q.tile % 24 === 23)).toBe(false)
    expect(p.levels[4]?.width).toBe(1464.5)
    // V8: L3 storage tile (0, r) and (1, r).
    const l3 = p.levels[3]?.pieces ?? []
    const row0 = l3.filter((q) => q.tile === 0)
    expect(row0.map(({ sx, sw, dx }) => [sx, sw, dx])).toEqual([
      [0, 510.5, 0],
      [513.5, 509, 510.5],
    ])
    expect(l3.find((q) => q.tile === 1)).toMatchObject({ sx: 1.5, dx: 1019.5 })
    // L1 storage tile 11 keeps sx 0-512 (frame 22 only).
    expect(
      p.levels[1]?.pieces.filter((q) => q.tile === 11).map((q) => [q.sx, q.sw]),
    ).toEqual([[0, 512]])
    // V7: L3 seams at 512·s hold 3 px overlaps (1.5 px each side).
    const at = (tile: number) =>
      (p.levels[3]?.pieces ?? []).filter((q) => q.tile === tile)
    expect(at(1).map((q) => q.sx)).toEqual([1.5, 513.5])
    await tiff.close()
  })
})
