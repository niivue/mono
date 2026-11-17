import { describe, expect, it } from 'bun:test'
import type { FocusBox, NVImage, SliceTile } from '@niivue/niivue'
import {
  nearestOnRay,
  type SubvolumeSelection,
  type SubvolumeSelectorHost,
  sliceAxisAt,
  sliceOutlineRects,
  subvolumeBox,
  UIKitSubvolumeSelector,
} from './subvolumeSelector'

type Vec3 = [number, number, number]

/** 8^3 voxels, 2 mm, origin (-10, -20, -30); voxel [x,y,z] holds x+100y+10000z. */
function makeVolume(extra: Record<string, unknown> = {}): NVImage {
  const img = new Float32Array(512)
  for (let i = 0; i < 512; i++)
    img[i] =
      (i % 8) + 100 * (Math.floor(i / 8) % 8) + 10000 * Math.floor(i / 64)
  return {
    img,
    dimsRAS: [3, 8, 8, 8],
    img2RASstep: [1, 8, 64],
    img2RASstart: [0, 0, 0],
    matRAS: Float32Array.from([
      2, 0, 0, -10, 0, 2, 0, -20, 0, 0, 2, -30, 0, 0, 0, 1,
    ]),
    calMin: 0,
    calMax: 1,
    hdr: { scl_slope: 1, scl_inter: 0, xyzt_units: 10 },
    ...extra,
  } as unknown as NVImage
}

const vox = (x: number, y: number, z: number): Vec3 => [
  -10 + 2 * x,
  -20 + 2 * y,
  -30 + 2 * z,
]

function rightClick(type = 'pointerdown', extra = {}): Event {
  return Object.assign(new Event(type, { cancelable: true }), {
    button: 2,
    shiftKey: false,
    clientX: 5,
    clientY: 5,
    ...extra,
  })
}

function makeHost(
  vol: NVImage,
  picks: { slice?: Vec3[]; render?: Vec3[]; exploded?: Vec3[] },
  isRender = false,
) {
  const canvas = new EventTarget()
  const host = {
    canvas: canvas as unknown as HTMLCanvasElement,
    volumes: [vol],
    focusBox: null as FocusBox | null,
    clientToCanvas: (x: number, y: number): [number, number] => [x, y],
    drawScene() {},
    hitTest: () => ({ isRender }),
    canvasToMM: () => picks.slice?.shift() ?? null,
    pickAt: async () => picks.render?.shift() ?? null,
    pickRay: (): { origin: Vec3; dir: Vec3 } | null => ({
      origin: [0, 0, 100],
      dir: [0, 0, -1],
    }),
    getScreenTiles: (): readonly SliceTile[] => [],
    pickExplodedBlock: () => {
      const mm = picks.exploded?.shift()
      return mm ? ({ mm } as never) : null
    },
  } satisfies SubvolumeSelectorHost
  return { canvas, host }
}

const settle = () => new Promise((r) => setTimeout(r, 0))

describe('subvolumeBox', () => {
  it('spans both corners in either order and clamps to the volume', () => {
    const box = subvolumeBox(makeVolume(), vox(5, 6, 9), vox(2, -3, 4))
    expect(box?.voxelOrigin).toEqual([2, 0, 4])
    expect(box?.voxelDims).toEqual([4, 7, 4])
    // Outer voxel edges: half a voxel (1 mm) past the centres.
    expect(box?.minMM).toEqual([-7, -21, -23])
    expect(box?.maxMM).toEqual([1, -7, -15])
  })

  it('is null when the box misses the volume', () => {
    expect(subvolumeBox(makeVolume(), vox(9, 0, 0), vox(12, 3, 3))).toBeNull()
  })
})

describe('sliceOutlineRects', () => {
  // A 128x128 px axial tile at (10, 20) showing x, y in [-64, 64] mm, at z = 0
  // (a power-of-two scale keeps the float32 MVP exact).
  const mvp = Float32Array.from([
    1 / 64,
    0,
    0,
    0,
    0,
    1 / 64,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    1,
  ])
  const axial = {
    axCorSag: 0,
    leftTopWidthHeight: [10, 20, 128, 128],
    mvpMatrix: mvp,
    planeNormal: [0, 0, 1],
    planePoint: [0, 0, 0],
  } as unknown as SliceTile
  const render = { ...axial, axCorSag: 4 } as unknown as SliceTile

  it('outlines the cross-section on a slice that cuts the box', () => {
    const box = { min: [-10, 0, -5] as Vec3, max: [20, 30, 5] as Vec3 }
    expect(sliceOutlineRects([axial, render], box, 0)).toEqual([
      { x: 64, y: 54, width: 30, height: 30 },
    ])
  })

  it('skips a slice that misses the box, grows a tiny one, clips to the tile', () => {
    expect(
      sliceOutlineRects([axial], { min: [0, 0, 1], max: [5, 5, 3] }, 0),
    ).toEqual([])
    // On the box face, off by float32 rounding, still cuts it.
    expect(
      sliceOutlineRects([axial], { min: [0, 0, 1e-5], max: [8, 8, 3] }, 0),
    ).toHaveLength(1)
    expect(
      sliceOutlineRects([axial], { min: [0, 0, 0], max: [1, 1, 0] }, 6),
    ).toEqual([{ x: 71.5, y: 80.5, width: 6, height: 6 }])
    expect(
      sliceOutlineRects([axial], { min: [40, 40, 0], max: [90, 90, 0] }, 0),
    ).toEqual([{ x: 114, y: 20, width: 24, height: 24 }])
  })
})

describe('nearestOnRay', () => {
  it('is the ray point nearest the target, or null without a ray', () => {
    const ray = { origin: [0, 0, 0] as Vec3, dir: [1, 0, 0] as Vec3 }
    expect(nearestOnRay(ray, [5, 3, -2])).toEqual([5, 0, 0])
    expect(nearestOnRay(null, [1, 1, 1])).toBeNull()
  })
})

// An axial tile at x 0-10 and a coronal one at x 10-20 (canvas px).
const viewTiles = [
  { axCorSag: 0, leftTopWidthHeight: [0, 0, 10, 10], planeNormal: [0, 0, 1] },
  { axCorSag: 1, leftTopWidthHeight: [10, 0, 10, 10], planeNormal: [0, 1, 0] },
] as unknown as SliceTile[]

describe('sliceAxisAt', () => {
  it('is the normal axis of the 2D tile under the point', () => {
    expect(sliceAxisAt(viewTiles, [5, 5])).toBe(2)
    expect(sliceAxisAt(viewTiles, [15, 5])).toBe(1)
    expect(sliceAxisAt(viewTiles, [25, 5])).toBeNull()
  })
})

describe('UIKitSubvolumeSelector.attach', () => {
  it('two right-clicks on a slice copy the box out and outline it', async () => {
    const got: SubvolumeSelection[] = []
    const corners: Vec3[] = []
    const sel = new UIKitSubvolumeSelector({
      onSelect: (s) => got.push(s),
      onCorner: (mm) => corners.push(mm),
    })
    const { canvas, host } = makeHost(makeVolume(), {
      slice: [vox(2, 3, 4), vox(3, 4, 5)],
    })
    const detach = sel.attach(host)
    const first = rightClick()
    canvas.dispatchEvent(first)
    expect(first.defaultPrevented).toBe(true)
    await settle()
    expect(sel.pendingCorner).toEqual(vox(2, 3, 4))
    // The first corner is outlined, fainter, as one voxel.
    expect(host.focusBox?.min).toEqual([-7, -15, -23])
    expect(host.focusBox?.max).toEqual([-5, -13, -21])
    expect(host.focusBox?.color[3]).toBe(0.5)
    canvas.dispatchEvent(rightClick())
    await settle()
    expect(got).toHaveLength(1)
    expect(corners).toEqual([vox(2, 3, 4)])
    expect(host.focusBox?.color[3]).toBe(1)
    const sub = got[0]?.subVolume
    expect(sub?.voxelOrigin).toEqual([2, 3, 4])
    expect(sub?.voxelDims).toEqual([2, 2, 2])
    expect(
      new Float32Array(sub?.nifti.buffer ?? new ArrayBuffer(0), 352, 1)[0],
    ).toBe(2 + 300 + 40000)
    expect(host.focusBox?.min).toEqual([-7, -15, -23])
    detach()
    expect(host.focusBox).toBeNull()
    canvas.dispatchEvent(rightClick())
    await settle()
    expect(sel.pendingCorner).toBeNull()
  })

  it('leaves the left button and Shift+right-click to the scene', async () => {
    const sel = new UIKitSubvolumeSelector()
    const { canvas, host } = makeHost(makeVolume(), { slice: [vox(1, 1, 1)] })
    sel.attach(host)
    const left = rightClick('pointerdown', { button: 0 })
    const menu = rightClick('pointerdown', { shiftKey: true })
    canvas.dispatchEvent(left)
    canvas.dispatchEvent(menu)
    await settle()
    expect(left.defaultPrevented || menu.defaultPrevented).toBe(false)
    expect(sel.pendingCorner).toBeNull()
  })

  it('depth-picks on the 3D render; a later press supersedes a slow pick', async () => {
    const got: SubvolumeSelection[] = []
    const sel = new UIKitSubvolumeSelector({ onSelect: (s) => got.push(s) })
    const { canvas, host } = makeHost(
      makeVolume(),
      { render: [vox(0, 0, 0), vox(7, 7, 7)] },
      true,
    )
    sel.attach(host)
    canvas.dispatchEvent(rightClick())
    canvas.dispatchEvent(rightClick())
    await settle()
    // The first pick was superseded by the second press before it resolved.
    expect(got).toHaveLength(0)
    expect(sel.pendingCorner).toEqual(vox(7, 7, 7))
    // A miss off the render tile (no ray) places nothing.
    host.pickRay = () => null
    canvas.dispatchEvent(rightClick())
    await settle()
    expect(got).toHaveLength(0)
  })

  it('over empty space the second 3D corner takes the first corner depth', async () => {
    const got: SubvolumeSelection[] = []
    const sel = new UIKitSubvolumeSelector({ onSelect: (s) => got.push(s) })
    const { canvas, host } = makeHost(makeVolume(), {}, true)
    sel.attach(host)
    // A miss with no first corner places nothing.
    host.pickAt = async () => null
    canvas.dispatchEvent(rightClick())
    await settle()
    expect(sel.pendingCorner).toBeNull()
    const picks: (Vec3 | null)[] = [vox(1, 2, 3), null]
    host.pickAt = async () => picks.shift() ?? null
    canvas.dispatchEvent(rightClick())
    await settle()
    canvas.dispatchEvent(rightClick())
    await settle()
    // The ray (0, 0, z) cut at the first corner's z: voxel (5, 10->7, 3).
    expect(got[0]?.voxelOrigin).toEqual([1, 2, 3])
    expect(got[0]?.voxelDims).toEqual([5, 6, 1])
  })

  it('a right-click on another slice orientation sets a one-slice box depth', async () => {
    const got: SubvolumeSelection[] = []
    const sel = new UIKitSubvolumeSelector({ onSelect: (s) => got.push(s) })
    const { canvas, host } = makeHost(makeVolume(), {
      slice: [vox(1, 2, 3), vox(4, 5, 3), vox(2, 2, 6), vox(0, 0, 1)],
    })
    host.getScreenTiles = () => viewTiles
    sel.attach(host)
    const axial = () => rightClick('pointerdown', { clientX: 5 })
    const coronal = (type = 'pointerdown') => rightClick(type, { clientX: 15 })
    canvas.dispatchEvent(axial())
    await settle()
    canvas.dispatchEvent(axial())
    await settle()
    expect(got[0]?.voxelDims).toEqual([4, 4, 1])
    // Hovering the coronal view previews the depth, fainter.
    host.canvasToMM = () => vox(2, 2, 7)
    canvas.dispatchEvent(coronal('pointermove'))
    expect(host.focusBox?.color[3]).toBe(0.5)
    expect(host.focusBox?.max[2]).toBe(-15)
    // Back on the axial view: the picked box again.
    canvas.dispatchEvent(rightClick('pointermove', { clientX: 5 }))
    expect(host.focusBox?.color[3]).toBe(1)
    expect(host.focusBox?.max[2]).toBe(-23)
    host.canvasToMM = () => vox(2, 2, 6)
    canvas.dispatchEvent(coronal())
    expect(got[1]?.voxelOrigin).toEqual([1, 2, 3])
    expect(got[1]?.voxelDims).toEqual([4, 4, 4])
    // Again, to the other side of the face.
    host.canvasToMM = () => vox(0, 0, 1)
    canvas.dispatchEvent(coronal())
    expect(got[2]?.voxelOrigin).toEqual([1, 2, 1])
    expect(got[2]?.voxelDims).toEqual([4, 4, 3])
    // On the face's own orientation: a new box.
    host.canvasToMM = () => vox(7, 7, 7)
    canvas.dispatchEvent(axial())
    await settle()
    expect(got).toHaveLength(3)
    expect(sel.pendingCorner).toEqual(vox(7, 7, 7))
  })

  it('corners on two orientations make no face to deepen', async () => {
    const got: SubvolumeSelection[] = []
    const sel = new UIKitSubvolumeSelector({ onSelect: (s) => got.push(s) })
    const { canvas, host } = makeHost(makeVolume(), {
      slice: [vox(1, 2, 3), vox(4, 2, 6), vox(5, 5, 5)],
    })
    host.getScreenTiles = () => viewTiles
    sel.attach(host)
    canvas.dispatchEvent(rightClick('pointerdown', { clientX: 5 }))
    await settle()
    canvas.dispatchEvent(rightClick('pointerdown', { clientX: 15 }))
    await settle()
    canvas.dispatchEvent(rightClick('pointerdown', { clientX: 15 }))
    await settle()
    expect(got).toHaveLength(1)
    expect(sel.pendingCorner).toEqual(vox(5, 5, 5))
  })

  it('picks an exploded chunked volume brick by brick, without an outline', async () => {
    const got: SubvolumeSelection[] = []
    const sel = new UIKitSubvolumeSelector({ onSelect: (s) => got.push(s) })
    const vol = makeVolume({
      chunkPlan: { chunks: [] },
      chunkExplode: { enabled: true },
    })
    const { canvas, host } = makeHost(
      vol,
      { exploded: [vox(1, 1, 1), vox(6, 6, 6)] },
      true,
    )
    sel.attach(host)
    canvas.dispatchEvent(rightClick())
    await settle()
    canvas.dispatchEvent(rightClick())
    await settle()
    expect(got[0]?.voxelDims).toEqual([6, 6, 6])
    expect(host.focusBox).toBeNull()
  })

  it('between corners the outline follows the pointer', async () => {
    const sel = new UIKitSubvolumeSelector()
    const { canvas, host } = makeHost(makeVolume(), {
      slice: [vox(1, 1, 1), vox(3, 2, 1)],
      render: [vox(4, 4, 4)],
    })
    sel.attach(host)
    canvas.dispatchEvent(rightClick('pointermove'))
    expect(host.focusBox).toBeNull()
    canvas.dispatchEvent(rightClick())
    await settle()
    canvas.dispatchEvent(rightClick('pointermove'))
    expect(host.focusBox?.max).toEqual([-3, -15, -27])
    expect(host.focusBox?.color[3]).toBe(0.5)
    host.hitTest = () => ({ isRender: true })
    canvas.dispatchEvent(rightClick('pointermove'))
    await settle()
    expect(host.focusBox?.max).toEqual([-1, -11, -21])
  })
})
