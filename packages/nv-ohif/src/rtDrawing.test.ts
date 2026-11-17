import { describe, expect, test } from 'bun:test'
import {
  fillRuns,
  lpsToVoxel,
  type Restyle,
  type RtLabels,
  rasterizeContours,
  rasterizeStructureSet,
  startRtDrawing,
} from './rtDrawing'

// Axis-aligned square, LPS triplets on plane z.
const square = (x0: number, y0: number, x1: number, y1: number, z: number) => [
  x0,
  y0,
  z,
  x1,
  y0,
  z,
  x1,
  y1,
  z,
  x0,
  y1,
  z,
]
const apply = (m: number[], [x, y, z]: number[]) =>
  [0, 4, 8].map(
    (r) =>
      (m[r] as number) * (x as number) +
      (m[r + 1] as number) * (y as number) +
      (m[r + 2] as number) * (z as number) +
      (m[r + 3] as number),
  )
// Identity RAS-voxel grid in LPS: voxel (i,j,k) at LPS (-i,-j,k).
const identityLps = [-1, 0, 0, 0, 0, -1, 0, 0, 0, 0, 1, 0]

describe('lpsToVoxel', () => {
  test('flippedPermutedAffine_invertsVox2mm', () => {
    // RAS mm = (2k + 5, -0.5 i + 3, 3 j - 7): permuted, flipped, scaled.
    const vox2mm = ([i, j, k]: [number, number, number]) => [
      2 * k + 5,
      -0.5 * i + 3,
      3 * j - 7,
    ]
    const m = lpsToVoxel(vox2mm)
    expect(m).not.toBeNull()
    const [x, y, z] = vox2mm([4, 6, 9])
    const vox = apply(m as number[], [
      -(x as number),
      -(y as number),
      z as number,
    ])
    for (const [a, v] of vox.entries())
      expect(v).toBeCloseTo([4, 6, 9][a] as number, 9)
  })

  test('singular_isNull', () => {
    expect(lpsToVoxel(() => [0, 0, 0])).toBeNull()
  })
})

describe('rasterizeContours', () => {
  const dims = [20, 20, 5] as const

  test('ringWithHole_fillsEvenOddAtVoxelCentres', () => {
    const bitmap = new Uint8Array(20 * 20 * 5)
    // Outer covers centres 2..11 (10x10), hole covers 5..8 (4x4); LPS x,y = -voxel.
    const outer = square(-1.5, -1.5, -11.5, -11.5, 2)
    const hole = square(-4.5, -4.5, -8.5, -8.5, 2)
    const { count, centroid, runs } = rasterizeContours(dims, identityLps, [
      outer,
      hole,
    ])
    fillRuns(bitmap, runs, 3)
    expect(count).toBe(100 - 16)
    expect(centroid).toEqual([6.5, 6.5, 2])
    expect(bitmap[2 * 400 + 2 * 20 + 2]).toBe(3)
    expect(bitmap[2 * 400 + 6 * 20 + 6]).toBe(0)
    expect(bitmap.reduce((s, v) => s + (v ? 1 : 0), 0)).toBe(84)
  })

  test('sagittalContour_fillsTheXSlice', () => {
    const bitmap = new Uint8Array(20 * 20 * 5)
    // Constant x = voxel 7; y centres 1..3, z centres 1..2.
    const c = [-7, -0.5, 0.5, -7, -3.5, 0.5, -7, -3.5, 2.5, -7, -0.5, 2.5]
    const { count, runs } = rasterizeContours(dims, identityLps, [c])
    fillRuns(bitmap, runs, 1)
    expect(count).toBe(6)
    expect(bitmap[1 * 400 + 1 * 20 + 7]).toBe(1)
    expect(bitmap[2 * 400 + 3 * 20 + 7]).toBe(1)
  })

  test('offGridSlice_isSkipped', () => {
    const { count } = rasterizeContours(dims, identityLps, [
      square(-1, -1, -3, -3, 9),
    ])
    expect(count).toBe(0)
  })
})

describe('rasterizeStructureSet', () => {
  const pts = (flat: number[]) =>
    Array.from({ length: flat.length / 3 }, (_, i) => ({
      x: flat[i * 3] as number,
      y: flat[i * 3 + 1] as number,
      z: flat[i * 3 + 2] as number,
    }))

  test('nestedRoi_drawnOverLargerAndKeepsOwnStats', () => {
    const bitmap = new Uint8Array(20 * 20 * 5)
    const { segments, stats, draw } = rasterizeStructureSet(
      [20, 20, 5],
      identityLps,
      [
        {
          ROIName: 'GTV',
          colorArray: [255, 0, 0],
          contourPoints: [
            {
              type: 'CLOSED_PLANAR',
              points: pts(square(-4.5, -4.5, -6.5, -6.5, 1)),
            },
          ],
        },
        { ROIName: 'empty', contourPoints: [] },
        {
          ROIName: 'BODY',
          colorArray: [0, 255, 0],
          contourPoints: [
            {
              type: 'CLOSED_PLANAR',
              points: pts(square(-0.5, -0.5, -9.5, -9.5, 1)),
            },
            { type: 'POINT', points: pts([-1, -1, 1]) },
          ],
        },
      ],
    )
    const showOnly = draw(bitmap)
    expect(segments).toEqual([
      { value: 1, label: 'GTV', rgb: [255, 0, 0] },
      { value: 2, label: 'BODY', rgb: [0, 255, 0] },
    ])
    expect(stats.get(1)?.count).toBe(4)
    expect(stats.get(2)?.count).toBe(81)
    expect(bitmap[400 + 5 * 20 + 5]).toBe(1)
    expect(bitmap[400 + 2 * 20 + 2]).toBe(2)
    // Hiding the nested ROI uncovers the larger one beneath it.
    showOnly(new Set([2]))
    expect(bitmap[400 + 5 * 20 + 5]).toBe(2)
  })

  // Review of #839: empty ROIs must not use up the 255 labels.
  test('a closed ROI after 255 empty ones is still drawn', () => {
    const empty = { ROIName: 'empty', contourPoints: [] }
    const { segments } = rasterizeStructureSet([20, 20, 5], identityLps, [
      ...Array.from({ length: 255 }, () => empty),
      {
        ROIName: 'target',
        contourPoints: [
          {
            type: 'CLOSED_PLANAR',
            points: pts(square(-0.5, -0.5, -9.5, -9.5, 1)),
          },
        ],
      },
    ])
    expect(segments.map((s) => s.label)).toEqual(['target'])
  })

  // Review of #839: a contour on the tilted plane z = y/2 crosses voxel
  // slices 1 to 4; each voxel lands on the slice nearest the plane.
  test('a tilted contour fills the slices its plane crosses', () => {
    const { runs, count } = rasterizeContours(
      [12, 12, 8],
      [-1, 0, 0, 0, 0, -1, 0, 0, 0, 0, 1, 0],
      [[-1, -1, 0.5, -9, -1, 0.5, -9, -9, 4.5, -1, -9, 4.5]],
    )
    const bitmap = new Uint8Array(12 * 12 * 8)
    fillRuns(bitmap, runs, 1)
    expect(count).toBe(64)
    expect(bitmap[1 * 144 + 2 * 12 + 5]).toBe(1)
    expect(bitmap[3 * 144 + 6 * 12 + 5]).toBe(1)
    expect(bitmap[3 * 144 + 2 * 12 + 5]).toBe(0)
  })

  // Review of #839: a hole on the same tilted plane groups with its outer
  // ring though their midpoints round to different slices.
  test('a coplanar tilted hole stays empty', () => {
    const { runs } = rasterizeContours(
      [12, 12, 8],
      [-1, 0, 0, 0, 0, -1, 0, 0, 0, 0, 1, 0],
      [
        [-1, -1, 0.5, -9, -1, 0.5, -9, -9, 4.5, -1, -9, 4.5],
        [-3, -2, 1, -3, -4, 2, -6, -4, 2, -6, -2, 1],
      ],
    )
    const bitmap = new Uint8Array(12 * 12 * 8)
    fillRuns(bitmap, runs, 1)
    expect(bitmap[2 * 144 + 3 * 12 + 4]).toBe(0)
    expect(bitmap[3 * 144 + 6 * 12 + 5]).toBe(1)
  })

  // Review of #839: a hole small enough to sit on one slice is still on its
  // outer ring's tilted plane, so it cuts a hole rather than filling.
  test('a one-slice hole on a tilted plane stays empty', () => {
    const { runs } = rasterizeContours(
      [30, 30, 5],
      [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0],
      [
        [1, 1, 0.1, 20, 1, 0.1, 20, 20, 2, 1, 20, 2],
        [5, 5, 0.5, 10, 5, 0.5, 10, 9, 0.9, 5, 9, 0.9],
      ],
    )
    const bitmap = new Uint8Array(30 * 30 * 5)
    fillRuns(bitmap, runs, 1)
    expect(bitmap[900 + 7 * 30 + 7]).toBe(0)
    expect(bitmap[900 + 14 * 30 + 15]).toBe(1)
  })

  // Review of #839: a hole whose slope is too small to measure still lies on its
  // outer ring's plane, so it cuts a hole rather than filling on its own slice.
  test('a hole too flat to measure on a tilted plane stays empty', () => {
    const z = (x: number) => 0.45 + 0.0004 * x
    const ring = (x0: number, x1: number, y0: number, y1: number) => [
      x0,
      y0,
      z(x0),
      x1,
      y0,
      z(x1),
      x1,
      y1,
      z(x1),
      x0,
      y1,
      z(x0),
    ]
    const { runs } = rasterizeContours(
      [302, 30, 3],
      [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0],
      [ring(1, 300, 1, 20), ring(50, 80, 5, 10)],
    )
    const bitmap = new Uint8Array(302 * 30 * 3)
    fillRuns(bitmap, runs, 1)
    expect(bitmap[65 + 7 * 302]).toBe(0)
    expect(bitmap[20 + 15 * 302]).toBe(1)
  })

  // Review of #839: the plane crosses slice 0 though its midpoint is below it.
  test('a tilted contour with an off-volume midpoint still fills', () => {
    const { count } = rasterizeContours(
      [12, 12, 8],
      [-1, 0, 0, 0, 0, -1, 0, 0, 0, 0, 1, 0],
      [[-1, -1, -3.5, -1, -9, 0.5, -9, -9, 0.5, -9, -1, -3.5]],
    )
    expect(count).toBeGreaterThan(0)
  })

  // Review of #839: DICOM's CLOSEDPLANAR_XOR contours combine by
  // exclusive-or; an inner one cuts a hole.
  test('fills CLOSEDPLANAR_XOR contours by exclusive-or', () => {
    const bitmap = new Uint8Array(20 * 20 * 5)
    const { stats, draw } = rasterizeStructureSet([20, 20, 5], identityLps, [
      {
        ROIName: 'ring',
        contourPoints: [
          {
            type: 'CLOSEDPLANAR_XOR',
            points: pts(square(-0.5, -0.5, -9.5, -9.5, 1)),
          },
          {
            type: 'CLOSEDPLANAR_XOR',
            points: pts(square(-3.5, -3.5, -6.5, -6.5, 1)),
          },
        ],
      },
    ])
    draw(bitmap)
    expect(stats.get(1)?.count).toBe(81 - 9)
    expect(bitmap[400 + 2 * 20 + 2]).toBe(1)
    expect(bitmap[400 + 5 * 20 + 5]).toBe(0)
  })
})

describe('startRtDrawing', () => {
  // Review of #839: cleanup closes only the drawing it installed.
  test('cleanup leaves a drawing installed after the RT one', async () => {
    const nv = {
      volumes: [{ dimsRAS: [3, 5, 5, 2] }],
      vox2mm: ([i, j, k]: [number, number, number]) => [i, j, k],
      drawingVolume: null as { img: Uint8Array } | null,
      createEmptyDrawing() {
        this.drawingVolume = { img: new Uint8Array(50) }
      },
      closeDrawing() {
        this.drawingVolume = null
      },
      refreshDrawing() {},
      addColormap: (name: string) => name,
      drawColormap: '',
      drawIsEnabled: false,
      drawOpacity: 0,
      drawRimOpacity: 0,
      addEventListener() {},
      removeEventListener() {},
    }
    const rt = {
      displaySetInstanceUID: 'rt',
      Modality: 'RTSTRUCT',
      async load() {},
      structureSet: {
        ROIContours: [
          {
            ROIName: 'roi',
            contourPoints: [
              {
                type: 'CLOSED_PLANAR',
                points: [
                  { x: -1, y: -1, z: 1 },
                  { x: -3, y: -1, z: 1 },
                  { x: -3, y: -3, z: 1 },
                  { x: -1, y: -3, z: 1 },
                ],
              },
            ],
          },
        ],
      },
    }
    let stop = () => {}
    await new Promise<void>((resolve) => {
      stop = startRtDrawing(nv as never, rt, {
        setNote: () => {},
        whenBase: Promise.resolve(true),
        onShown: () => {
          resolve()
          return () => {}
        },
      })
    })
    const replacement = { img: new Uint8Array(50) }
    nv.drawingVolume = replacement
    stop()
    expect(nv.drawingVolume).toBe(replacement)
    nv.createEmptyDrawing()
    const again = startRtDrawing(nv as never, rt, {
      setNote: () => {},
      whenBase: Promise.resolve(true),
    })
    await new Promise((r) => setTimeout(r, 0))
    again()
    expect(nv.drawingVolume).toBeNull()
  })

  // Review of #839: replacing the RT drawing puts the prior style back, but
  // never over a style the user set.
  const square4 = [
    { x: -1, y: -1, z: 1 },
    { x: -3, y: -1, z: 1 },
    { x: -3, y: -3, z: 1 },
    { x: -1, y: -3, z: 1 },
  ]
  function styleRig(contourType = 'CLOSED_PLANAR') {
    let onChanged = () => {}
    const nv = {
      volumes: [{ dimsRAS: [3, 5, 5, 2] }],
      vox2mm: ([i, j, k]: [number, number, number]) => [i, j, k],
      drawingVolume: null as { img: Uint8Array } | null,
      createEmptyDrawing() {
        this.drawingVolume = { img: new Uint8Array(50) }
        onChanged()
      },
      closeDrawing() {
        this.drawingVolume = null
        onChanged()
      },
      refreshDrawing() {},
      addColormap: (name: string) => name,
      drawColormap: 'gray',
      drawIsEnabled: false,
      drawOpacity: 0.8,
      drawRimOpacity: -1,
      drawingGeneration: 0,
      addEventListener: (_: string, f: () => void) => {
        onChanged = f
      },
      removeEventListener: () => {
        onChanged = () => {}
      },
    }
    const rt = {
      displaySetInstanceUID: 'rt',
      Modality: 'RTSTRUCT',
      async load() {},
      structureSet: {
        ROIContours: [
          {
            ROIName: 'roi',
            contourPoints: [{ type: contourType, points: square4 }],
          },
        ],
      },
    }
    return { nv, rt }
  }
  async function showWithPanel(nv: unknown, rt: unknown) {
    let restyle: Restyle = (write) => write()
    await new Promise<void>((resolve) => {
      startRtDrawing(nv as never, rt as never, {
        setNote: () => {},
        whenBase: Promise.resolve(true),
        onShown: (_segments, _labels, r) => {
          restyle = r
          resolve()
          return () => {}
        },
      })
    })
    return restyle
  }

  test('a replacement drawing gets the prior style back', async () => {
    const { nv, rt } = styleRig()
    const restyle = await showWithPanel(nv, rt)
    // The seg panel restyles the drawing it lists.
    restyle(() => {
      nv.drawColormap = 'seg-panel-pane'
      nv.drawOpacity = 0.4
    })
    nv.createEmptyDrawing()
    expect(nv.drawColormap).toBe('gray')
    expect(nv.drawOpacity).toBe(0.8)
    expect(nv.drawRimOpacity).toBe(-1)
  })

  test("a user's style survives replacement", async () => {
    const { nv, rt } = styleRig()
    await showWithPanel(nv, rt)
    nv.drawColormap = 'user-hot'
    nv.createEmptyDrawing()
    expect(nv.drawColormap).toBe('user-hot')
  })

  test("an unchanged panel sync does not claim the user's style", async () => {
    const { nv, rt } = styleRig()
    const restyle = await showWithPanel(nv, rt)
    nv.drawColormap = 'user-hot'
    // An unrelated panel event: the style key is unchanged, so it writes nothing.
    restyle(() => {})
    nv.createEmptyDrawing()
    expect(nv.drawColormap).toBe('user-hot')
    expect(nv.drawOpacity).toBe(0.8)
  })

  // Review of #839: nothing to show keeps the drawing (and its undo history).
  test('a structure set with no closed contours keeps the drawing', async () => {
    const { nv, rt } = styleRig('POINT')
    const mine = { img: Uint8Array.from([7]) }
    nv.drawingVolume = mine
    let note = ''
    startRtDrawing(nv as never, rt as never, {
      setNote: (m) => {
        note = m
      },
      whenBase: Promise.resolve(true),
    })
    await new Promise((r) => setTimeout(r, 0))
    expect(note).toContain('no closed contours')
    expect(nv.drawingVolume).toBe(mine)
  })

  // Review of #839: a drawing made while the structure set loads is kept.
  test('a drawing made during the load is not replaced', async () => {
    let finishLoad = () => {}
    const loading = new Promise<void>((r) => {
      finishLoad = r
    })
    const nv = {
      volumes: [{ dimsRAS: [3, 5, 5, 2] }],
      vox2mm: ([i, j, k]: [number, number, number]) => [i, j, k],
      drawingGeneration: 0,
      drawingVolume: null as { img: Uint8Array } | null,
      createEmptyDrawing() {
        this.drawingGeneration++
        this.drawingVolume = { img: new Uint8Array(50) }
      },
      refreshDrawing() {},
      addColormap: (name: string) => name,
    }
    const rt = {
      displaySetInstanceUID: 'rt',
      Modality: 'RTSTRUCT',
      load: () => loading,
      structureSet: {
        ROIContours: [
          {
            ROIName: 'roi',
            contourPoints: [
              {
                type: 'CLOSED_PLANAR',
                points: [
                  { x: -1, y: -1, z: 1 },
                  { x: -3, y: -1, z: 1 },
                  { x: -3, y: -3, z: 1 },
                  { x: -1, y: -3, z: 1 },
                ],
              },
            ],
          },
        ],
      },
    }
    let shown = false
    startRtDrawing(nv as never, rt, {
      setNote: () => {},
      whenBase: Promise.resolve(true),
      onShown: () => {
        shown = true
        return () => {}
      },
    })
    nv.createEmptyDrawing()
    const mine = nv.drawingVolume
    finishLoad()
    await new Promise((r) => setTimeout(r, 0))
    expect(shown).toBe(false)
    expect(nv.drawingVolume).toBe(mine)
  })

  test('loadsStructureSet_fillsDrawingAndListsRois', async () => {
    const img = new Uint8Array(20 * 20 * 5)
    const nv = {
      volumes: [{ dimsRAS: [3, 20, 20, 5] }],
      vox2mm: ([i, j, k]: [number, number, number]) => [i, j, k],
      drawingVolume: null as { img: Uint8Array } | null,
      createEmptyDrawing() {
        this.drawingVolume = { img }
        this.drawIsEnabled = true
      },
      closeDrawing() {
        this.drawingVolume = null
      },
      refreshDrawing() {},
      addColormap: (name: string) => name,
      drawColormap: '',
      drawIsEnabled: false,
      drawOpacity: 0,
      drawRimOpacity: 0,
      addEventListener() {},
      removeEventListener() {},
    }
    let loadedWith: unknown
    const rt = {
      displaySetInstanceUID: 'rt',
      Modality: 'RTSTRUCT',
      structureSet: undefined as unknown,
      async load(o: unknown) {
        loadedWith = o
        this.structureSet = {
          ROIContours: [
            {
              ROIName: 'GTV',
              contourPoints: [
                {
                  type: 'CLOSED_PLANAR',
                  points: [
                    { x: -1.5, y: -1.5, z: 2 },
                    { x: -3.5, y: -1.5, z: 2 },
                    { x: -3.5, y: -3.5, z: 2 },
                    { x: -1.5, y: -3.5, z: 2 },
                  ],
                },
              ],
            },
          ],
        }
      },
    }
    const shown = new Promise<RtLabels>((resolve) => {
      startRtDrawing(nv as never, rt, {
        setNote: () => {},
        whenBase: Promise.resolve(true),
        onShown: (_segments, labels) => {
          resolve(labels)
          return () => {}
        },
      })
    })
    const labels = await shown
    expect(labels.stats.get(1)?.count).toBe(4)
    expect(loadedWith).toEqual({
      headers: undefined,
      createSegmentation: false,
    })
    expect(nv.drawIsEnabled).toBe(false)
    expect(nv.drawColormap).toBe('rt-rt')
    expect(img[2 * 400 + 2 * 20 + 2]).toBe(1)
    labels.showOnly(new Set())
    expect(img[2 * 400 + 2 * 20 + 2]).toBe(0)
  })
})
