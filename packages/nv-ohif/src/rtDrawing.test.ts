import { describe, expect, test } from 'bun:test'
import {
  fillRuns,
  lpsToVoxel,
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
    const { segments, stats, showOnly } = rasterizeStructureSet(
      bitmap,
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
    expect(segments).toEqual([
      { value: 1, label: 'GTV', rgb: [255, 0, 0] },
      { value: 3, label: 'BODY', rgb: [0, 255, 0] },
    ])
    expect(stats.get(1)?.count).toBe(4)
    expect(stats.get(3)?.count).toBe(81)
    expect(bitmap[400 + 5 * 20 + 5]).toBe(1)
    expect(bitmap[400 + 2 * 20 + 2]).toBe(3)
    // Hiding the nested ROI uncovers the larger one beneath it.
    showOnly(new Set([3]))
    expect(bitmap[400 + 5 * 20 + 5]).toBe(3)
  })
})

describe('startRtDrawing', () => {
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
