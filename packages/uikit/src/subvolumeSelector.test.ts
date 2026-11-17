import { describe, expect, it } from 'bun:test'
import type { FocusBox, NVImage } from '@niivue/niivue'
import {
  type SubvolumeSelection,
  type SubvolumeSelectorHost,
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

describe('UIKitSubvolumeSelector.attach', () => {
  it('two right-clicks on a slice copy the box out and outline it', async () => {
    const got: SubvolumeSelection[] = []
    const sel = new UIKitSubvolumeSelector({ onSelect: (s) => got.push(s) })
    const { canvas, host } = makeHost(makeVolume(), {
      slice: [vox(2, 3, 4), vox(3, 4, 5)],
    })
    const detach = sel.attach(host)
    const first = rightClick()
    canvas.dispatchEvent(first)
    expect(first.defaultPrevented).toBe(true)
    await settle()
    expect(sel.pendingCorner).toEqual(vox(2, 3, 4))
    canvas.dispatchEvent(rightClick())
    await settle()
    expect(got).toHaveLength(1)
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
    canvas.dispatchEvent(rightClick())
    await settle()
    expect(got).toHaveLength(0)
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
})
