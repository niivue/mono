import { describe, expect, mock, test } from 'bun:test'
import type { NVImage } from '@/NVTypes'

// NVVolume pulls in the writers' import.meta.glob, which bun cannot load, so
// its converter is stood in for: one voxel, x's sign in alpha's lowest bit,
// as the real one encodes it.
mock.module('./NVVolume', () => ({
  convertFloat32RGBVector: (hdr: unknown, v1: Float32Array) => ({
    hdr: { ...(hdr as object), dims: [3, 1, 1, 1, 1, 1, 1, 1] },
    img: new Uint8Array([0, 0, 0, 248 + (v1[0] > 0 ? 1 : 0)]),
  }),
}))
const { loadImgV1 } = await import('./TensorProcessing')

/** One voxel whose direction points along +x, as a tensor reader keeps it. */
function vectorVolume(stored: boolean): NVImage {
  const v1 = new Float32Array([2, 0, 0])
  return {
    hdr: { dims: [4, 1, 1, 1, 3, 1, 1, 1], scl_slope: 1, scl_inter: 0 },
    img: v1.slice(),
    v1: stored ? v1 : undefined,
    nVox3D: 1,
    nFrame4D: 3,
    frame4D: 2,
  } as unknown as NVImage
}

/** Whether the converted voxel's x component points the positive way. */
const xPositive = (vol: NVImage) => ((vol.img as Uint8Array)[3] & 1) === 1

describe('loadImgV1', () => {
  test('a flip acts on one conversion, so a stored V1 is flipped afresh each time', () => {
    const vol = vectorVolume(true)
    expect(loadImgV1(vol, true)).toBe(true)
    expect(xPositive(vol)).toBe(false)
    expect(loadImgV1(vol, true)).toBe(true)
    expect(xPositive(vol)).toBe(false)
    expect(loadImgV1(vol)).toBe(true)
    expect(xPositive(vol)).toBe(true)
  })

  test('the converted image has one frame, and shows it', () => {
    const vol = vectorVolume(false)
    expect(loadImgV1(vol)).toBe(true)
    expect(vol.nFrame4D).toBe(1)
    expect(vol.frame4D).toBe(0)
  })
})
